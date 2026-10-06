// src/cli/factory-cli.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFactoryArgs } from './parse-args.mjs';
import { listInputVideos } from '../input/video-list.mjs';
import { runWorkerPool, forkVideoWorker, buildVideoTimeout } from '../runner/worker-pool.mjs';
import { isVideoDone, readManifest, buildManifest, formatSummary, formatRunStamp, writeRunRecord } from '../runner/manifest.mjs';
import { runPreflight, listClosedPorts, startProductTunnel } from '../runner/preflight.mjs';
import { buildOutputPathMap } from '../runner/output-paths.mjs';
import { readSeeonMeetVersion } from '../product/product-version.mjs';
import { FACTORY_ROOT } from '../product/product-paths.mjs';
import { resolveFfmpegPaths } from '../media/ffmpeg.mjs';
import { loadPipelineConfig } from '../product/product-loader.mjs';

const PROGRESS_LOG_MS = 5000;
const STOP_SIGNAL_LIST = ['SIGINT', 'SIGTERM'];

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

// 영상마다 워커 프로세스를 띄워 결과를 모은다. 진행은 영상마다 PROGRESS_LOG_MS 간격으로만 찍고, 영상 하나가 끝날 때마다 onResult 를 부른다.
function runPendingJobList({ pendingJobList, outDir, concurrency, env, workerPath, videoTimeout, signal, onResult, log }) {
  const lastLogAtMap = new Map();
  let doneCount = 0;
  return runWorkerPool({
    jobList: pendingJobList, concurrency, signal,
    startWorker: (job) => {
      const pathMap = buildOutputPathMap({ outDir, outStem: job.outStem });
      // 끝남 표시(JSON)는 이번 작업이 마지막에 새로 써야만 믿을 수 있다. 이전 실행의 JSON·mp3 를 먼저 지워
      // --force 재실행 등이 도중에 죽었을 때 잘린 mp3 와 이전 JSON 이 끝난 영상으로 보이지 않게 한다.
      fs.rmSync(pathMap.jsonPath, { force: true });
      fs.rmSync(pathMap.mp3Path, { force: true });
      return forkVideoWorker({
        job, outDir, logPath: pathMap.logPath, env, workerPath, ...videoTimeout,
        onProgress: ({ videoTimeMs, durationMs, adCount }) => {
          const now = Date.now();
          if (now - (lastLogAtMap.get(job.outStem) || 0) < PROGRESS_LOG_MS) return;
          lastLogAtMap.set(job.outStem, now);
          log.log(`[factory] ${job.videoId} 영상 ${Math.round(videoTimeMs / 1000)}/${Math.round(durationMs / 1000)}초 · AD ${adCount}`);
        },
      });
    },
    onEvent: ({ type, job, result }) => {
      if (type === 'start') log.log(`[factory] ▶ ${job.videoId}`);
      if (type !== 'end') return;
      doneCount += 1;
      onResult(result);
      log.log(result.status === 'done'
        ? `[factory] ✔ [${doneCount}/${pendingJobList.length}] ${job.videoId} AD ${result.adCount}개 · ${Math.round(result.processingMs / 1000)}초`
        : `[factory] ✖ [${doneCount}/${pendingJobList.length}] ${job.videoId} ${result.errorMessage}`);
    },
  });
}

// SIGINT·SIGTERM 을 처음 받을 때만 onSignal 을 부른다(once). 같은 신호를 한 번 더 받으면 기본 동작대로 바로 끝난다. 떼는 함수를 돌려준다.
function listenStopSignal({ signalSource, onSignal }) {
  const handlerMap = new Map(STOP_SIGNAL_LIST.map((signalName) => [signalName, () => onSignal(signalName)]));
  for (const [signalName, handler] of handlerMap) signalSource.once(signalName, handler);
  return () => {
    for (const [signalName, handler] of handlerMap) signalSource.off(signalName, handler);
  };
}

// 종료 코드를 돌려준다: 시작 전 점검 실패·영상 없음·영상 하나라도 실패면 1, 신호로 중단하면 128 + 신호 번호(SIGINT 130, SIGTERM 143).
// workerPath·checkPort·runVersion·startTunnel·signalSource 는 테스트가 실제 워커·GPU 포트·SSH·프로세스 신호 없이 돌리려고 바꿔 끼운다.
export async function runFactoryCli({
  argList, env = process.env, log = console, workerPath, checkPort, runVersion, startTunnel = startProductTunnel, signalSource = process,
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

  const runOptions = { ...options, input: path.resolve(options.input), out: outDir };
  const seeonMeet = readSeeonMeetVersion();
  const abortController = new AbortController();
  let interruptedBy = null;
  let stopListening = null;
  let manifest;
  try {
    await fs.promises.mkdir(outDir, { recursive: true });
    const skippedJobList = options.isForced ? [] : jobList.filter((job) => isVideoDone({ outDir, ...job }));
    const pendingJobList = jobList.filter((job) => !skippedJobList.includes(job));
    const startedAt = new Date().toISOString();
    const resultByStem = new Map();
    const buildCurrentManifest = (endedAt) => buildManifest({
      previousManifest, runOptions, seeonMeet, jobList, resultList: [...resultByStem.values()], skippedJobList, startedAt, endedAt, interruptedBy,
    });
    writeRunRecord({ outDir, manifest: buildCurrentManifest(null) });
    log.log(`[factory] 영상 ${jobList.length}개(건너뜀 ${skippedJobList.length}) · 동시 ${options.concurrency} · 출력 ${outDir}`);
    stopListening = listenStopSignal({
      signalSource,
      onSignal: (signalName) => {
        if (interruptedBy) return;
        interruptedBy = signalName;
        log.error(`[factory] ${signalName} 받음 — 돌던 워커를 멈추고 기록을 남긴 뒤 끝낸다(한 번 더 보내면 바로 끝난다)`);
        abortController.abort(signalName);
      },
    });
    await runPendingJobList({
      pendingJobList, outDir, concurrency: options.concurrency, env, workerPath, log,
      videoTimeout: buildVideoTimeout({ timeoutMin: options.timeoutMin }), signal: abortController.signal,
      onResult: (result) => {
        resultByStem.set(result.outStem, result);
        // 중간 기록을 못 써도 영상 처리는 계속한다. 마지막 기록은 아래에서 다시 쓴다.
        try {
          writeRunRecord({ outDir, manifest: buildCurrentManifest(null) });
        } catch (error) {
          log.warn(`[factory] 실행 기록 중간 쓰기 실패: ${error.message}`);
        }
      },
    });
    manifest = buildCurrentManifest(new Date().toISOString());
    writeRunRecord({ outDir, manifest });
  } finally {
    stopListening?.();
    await tunnel?.stop();
  }
  log.log(formatSummary(manifest));
  if (interruptedBy) return 128 + os.constants.signals[interruptedBy];
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
