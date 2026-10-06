// src/cli/factory-cli.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFactoryArgs } from './parse-args.mjs';
import { listInputVideos } from '../input/video-list.mjs';
import { runWorkerPool, forkVideoWorker } from '../runner/worker-pool.mjs';
import { isVideoDone, readManifest, buildManifest, formatSummary, formatRunStamp } from '../runner/manifest.mjs';
import { runPreflight, listClosedPorts, startProductTunnel } from '../runner/preflight.mjs';
import { buildOutputPathMap } from '../runner/output-paths.mjs';
import { readSeeonMeetVersion } from '../product/product-version.mjs';
import { FACTORY_ROOT } from '../product/product-paths.mjs';
import { resolveFfmpegPaths } from '../media/ffmpeg.mjs';
import { loadPipelineConfig } from '../product/product-loader.mjs';

const PROGRESS_LOG_MS = 5000;

// 직접 실행할 때만 저장소 .env 를 process.env 로 읽는다. 이미 있는 환경변수가 이긴다.
function loadFactoryEnv() {
  const envPath = path.join(FACTORY_ROOT, '.env');
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
}

// GPU 포트가 닫혀 있으면 제품 터널로 연 뒤 다시 점검한다. 연 터널은 돌려줘 실행이 끝날 때 닫는다.
async function openGpuAccess({ preflight, env, pipelineConfig, checkPort, startTunnel, log }) {
  if (!preflight.closedPortList.length) return null;
  log.log(`[factory] GPU 포트 닫힘(${preflight.closedPortList.join(', ')}) — 제품 터널 모듈로 연결을 시도한다`);
  let tunnel = null;
  try {
    tunnel = await startTunnel({ env, pipelineConfig });
    if (!tunnel) preflight.problemList.push('제품 터널을 열지 않았다 — SEEON_GPU_SSH_KEY(앱 전용 키)가 없거나 SEEON_GPU_TUNNEL=off 다');
  } catch (error) {
    preflight.problemList.push(error.message);
  }
  // 터널이 열려도 원격 주소를 쓰는 서비스는 터널로 넘기지 않으므로 닫힌 포트를 다시 본다.
  const closedPortList = tunnel ? await listClosedPorts({ pipelineConfig, checkPort }) : preflight.closedPortList;
  if (closedPortList.length) preflight.problemList.push(`GPU 서비스에 닿지 못했다: ${closedPortList.join(', ')}`);
  return tunnel;
}

// 영상마다 워커 프로세스를 띄워 결과를 모으고, 진행은 영상마다 PROGRESS_LOG_MS 간격으로만 찍는다.
function runPendingJobList({ pendingJobList, outDir, concurrency, env, workerPath, log }) {
  const lastLogAtMap = new Map();
  let doneCount = 0;
  return runWorkerPool({
    jobList: pendingJobList, concurrency,
    startWorker: (job) => forkVideoWorker({
      job, outDir, logPath: buildOutputPathMap({ outDir, outStem: job.outStem }).logPath, env, workerPath,
      onProgress: ({ videoTimeMs, durationMs, adCount }) => {
        const now = Date.now();
        if (now - (lastLogAtMap.get(job.outStem) || 0) < PROGRESS_LOG_MS) return;
        lastLogAtMap.set(job.outStem, now);
        log.log(`[factory] ${job.videoId} 영상 ${Math.round(videoTimeMs / 1000)}/${Math.round(durationMs / 1000)}초 · AD ${adCount}`);
      },
    }),
    onEvent: ({ type, job, result }) => {
      if (type === 'start') log.log(`[factory] ▶ ${job.videoId}`);
      if (type !== 'end') return;
      doneCount += 1;
      log.log(result.status === 'done'
        ? `[factory] ✔ [${doneCount}/${pendingJobList.length}] ${job.videoId} AD ${result.adCount}개 · ${Math.round(result.processingMs / 1000)}초`
        : `[factory] ✖ [${doneCount}/${pendingJobList.length}] ${job.videoId} ${result.errorMessage}`);
    },
  });
}

// 종료 코드를 돌려준다: 시작 전 점검 실패·영상 없음·영상 하나라도 실패면 1.
// workerPath·checkPort·runVersion·startTunnel 은 테스트가 실제 워커·GPU 포트·SSH 없이 돌리려고 바꿔 끼운다.
export async function runFactoryCli({
  argList, env = process.env, log = console, workerPath, checkPort, runVersion, startTunnel = startProductTunnel,
}) {
  const options = parseFactoryArgs(argList);
  // 부모 프로세스는 제품 설정만 읽는다(시계 범위·electron 대역은 워커에서만 깐다).
  const { readPipelineConfig } = loadPipelineConfig();
  const pipelineConfig = readPipelineConfig(env);
  const { ffmpegPath, ffprobePath } = resolveFfmpegPaths({ env });
  const jobList = (await listInputVideos({ input: options.input, language: options.language, limit: options.limit }))
    .map((job) => ({ ...job, isPageTransitionIncluded: options.isPageTransitionIncluded }));
  if (!jobList.length) { log.error('[factory] 처리할 영상이 없다'); return 1; }
  const outDir = path.resolve(options.out ?? path.join(FACTORY_ROOT, 'out', formatRunStamp(new Date())));
  // 이전 manifest 가 깨져 있으면 영상을 다 돌린 뒤가 아니라 지금 멈춘다.
  const previousManifest = readManifest({ outDir });

  const preflight = await runPreflight({ pipelineConfig, ffmpegPath, ffprobePath, checkPort, runVersion });
  const tunnel = await openGpuAccess({ preflight, env, pipelineConfig, checkPort, startTunnel, log });
  if (preflight.problemList.length) {
    for (const problem of preflight.problemList) log.error(`[factory] 시작 전 점검 실패: ${problem}`);
    await tunnel?.stop();
    return 1;
  }

  let manifest;
  try {
    await fs.promises.mkdir(outDir, { recursive: true });
    const skippedJobList = options.isForced ? [] : jobList.filter((job) => isVideoDone({ outDir, outStem: job.outStem }));
    const pendingJobList = jobList.filter((job) => !skippedJobList.includes(job));
    const startedAt = new Date().toISOString();
    log.log(`[factory] 영상 ${jobList.length}개(건너뜀 ${skippedJobList.length}) · 동시 ${options.concurrency} · 출력 ${outDir}`);
    const resultList = await runPendingJobList({ pendingJobList, outDir, concurrency: options.concurrency, env, workerPath, log });
    manifest = buildManifest({
      previousManifest, runOptions: { ...options, input: path.resolve(options.input), out: outDir },
      seeonMeet: readSeeonMeetVersion(), jobList, resultList, skippedJobList, startedAt, endedAt: new Date().toISOString(),
    });
  } finally {
    await tunnel?.stop();
  }
  await fs.promises.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await fs.promises.writeFile(path.join(outDir, 'summary.txt'), formatSummary(manifest));
  log.log(formatSummary(manifest));
  return manifest.counts.failed > 0 ? 1 : 0;
}

// node 는 진입 파일의 심볼릭 링크를 풀어 import.meta.url 을 만들므로 argv 경로도 실제 경로로 맞춰 비교한다.
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  loadFactoryEnv();
  runFactoryCli({ argList: process.argv.slice(2) })
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error) => { console.error(`[factory] ${error.message}`); process.exitCode = 1; });
}
