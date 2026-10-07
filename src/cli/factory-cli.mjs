// src/cli/factory-cli.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFactoryArgs } from './parse-args.mjs';
import { listInputVideos } from '../input/video-list.mjs';
import { runWorkerPool, forkVideoWorker, buildVideoTimeout } from '../runner/worker-pool.mjs';
import { inspectVideoResult, readManifest, buildManifest, formatSummary, formatRunStamp, writeRunRecord } from '../runner/manifest.mjs';
import { runPreflight, listDownServices, startProductTunnel, buildMemoryWarning } from '../runner/preflight.mjs';
import { buildOutputPathMap } from '../runner/output-paths.mjs';
import { acquireRunLock } from '../runner/run-lock.mjs';
import { assertRemovableWorkDir, removeWorkDir } from '../runner/work-dir.mjs';
import { formatWarningBrief } from '../runner/result-health.mjs';
import { redactUrlCredential } from '../util/redact-url-credential.mjs';
import { readResultIdentity } from '../runner/result-identity.mjs';
import { FACTORY_ROOT } from '../product/product-paths.mjs';
import { resolveFfmpegPaths } from '../media/ffmpeg.mjs';
import { loadPipelineConfig } from '../product/product-loader.mjs';

const PROGRESS_LOG_MS = 5000;
// SIGHUP 은 터미널이 닫힐 때(tmux·nohup 없이 SSH 로 돌리다 연결이 끊김) 온다. 받지 않으면 기본 동작으로 바로 죽어
// manifest 가 "진행 중"으로 남으므로 Ctrl-C 와 같이 정리하고 끝낸다.
const STOP_SIGNAL_LIST = ['SIGINT', 'SIGTERM', 'SIGHUP'];

// 직접 실행할 때만 저장소 .env 를 process.env 로 읽는다. 이미 있는 환경변수가 이긴다.
function loadFactoryEnv() {
  const envPath = path.join(FACTORY_ROOT, '.env');
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
}

// GPU 서비스가 HTTP 로 답하지 않으면 제품 터널로 연 뒤 다시 점검한다. 연 터널은 돌려줘 실행이 끝날 때 닫는다.
async function openGpuAccess({ preflight, env, pipelineConfig, checkService, startTunnel, log }) {
  if (!preflight.downServiceList.length) return null;
  log.log(`[factory] GPU 서비스 응답 없음(${preflight.downServiceList.join(', ')}) — 제품 터널 모듈로 연결을 시도한다`);
  let tunnel = null;
  try {
    tunnel = await startTunnel({ env, pipelineConfig });
    if (!tunnel) preflight.problemList.push('제품 터널을 열지 않았다 — SEEON_GPU_SSH_KEY(앱 전용 키)가 없거나 SEEON_GPU_TUNNEL=off 다');
  } catch (error) {
    preflight.problemList.push(error.message);
  }
  // 터널이 열려도 원격 주소를 쓰는 서비스는 터널로 넘기지 않고, 터널 뒤 서비스가 죽었을 수도 있으므로 다시 본다.
  const downServiceList = tunnel ? await listDownServices({ pipelineConfig, checkService }) : preflight.downServiceList;
  if (downServiceList.length) preflight.problemList.push(`GPU 서비스에 닿지 못했다: ${downServiceList.join(', ')}`);
  return tunnel;
}

// 다시 처리하는 영상의 이전 출력을 워커를 띄우기 전에 지운다.
// 끝남 표시(JSON)는 이번 작업이 마지막에 새로 써야만 믿을 수 있다. JSON·mp3 를 먼저 지워 --force 재실행 등이 도중에 죽었을 때
// 잘린 mp3 와 이전 JSON 이 끝난 영상으로 보이지 않게 한다. 작업 폴더(AD wav·제품 기록·합성 조각)도 비워 이전 실행의 파일이 섞이지 않게 한다.
function clearPreviousOutput({ outDir, pathMap }) {
  // 작업 폴더는 출력 폴더 바로 아래 <출력 이름>/ 이다. 이름이 어긋나 다른 곳을 가리키면 지우지 않고 멈춘다.
  if (path.dirname(pathMap.workDir) !== outDir) throw new Error(`작업 폴더가 출력 폴더 바로 아래가 아니다: ${pathMap.workDir}`);
  // 그 자리에 공장 표식이 없는 사용자 폴더 등이 있으면 아무것도 지우지 않고 이 영상을 실패로 둔다.
  assertRemovableWorkDir({ workDir: pathMap.workDir });
  fs.rmSync(pathMap.jsonPath, { force: true });
  fs.rmSync(pathMap.mp3Path, { force: true });
  removeWorkDir({ workDir: pathMap.workDir });
}

// 지금과 같은 영상·코드 버전·결과 설정으로 끝난 영상만 건너뛴다. 끝났는데 달라서 다시 만드는 영상은 이유를 한 줄씩 찍는다.
function selectSkippedJobList({ jobList, outDir, identity, log }) {
  return jobList.filter((job) => {
    const { status, mismatchList } = inspectVideoResult({ outDir, ...job, identity });
    if (status === 'mismatch') log.log(`[factory] ↻ ${job.videoId} 이전 완료 결과와 달라 다시 만든다 — ${mismatchList.join(' · ')}`);
    return status === 'done';
  });
}

// 영상마다 워커 프로세스를 띄워 결과를 모은다. 진행은 영상마다 PROGRESS_LOG_MS 간격으로만 찍고, 영상 하나가 끝날 때마다 onResult 를 부른다.
function runPendingJobList({ pendingJobList, outDir, concurrency, env, workerPath, videoTimeout, signal, forceSignal, onResult, log }) {
  const lastLogAtMap = new Map();
  let doneCount = 0;
  return runWorkerPool({
    jobList: pendingJobList, concurrency, signal, forceSignal,
    startWorker: (job) => {
      const pathMap = buildOutputPathMap({ outDir, outStem: job.outStem });
      clearPreviousOutput({ outDir, pathMap });
      return forkVideoWorker({
        job, outDir, logPath: pathMap.logPath, env, workerPath, runConcurrency: concurrency, ...videoTimeout,
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
      const warningText = formatWarningBrief(result.warningList);
      log.log(result.status === 'done'
        ? `[factory] ✔ [${doneCount}/${pendingJobList.length}] ${job.videoId} AD ${result.adCount}개 · ${Math.round(result.processingMs / 1000)}초${warningText ? ` ${warningText}` : ''}`
        : `[factory] ✖ [${doneCount}/${pendingJobList.length}] ${job.videoId} ${result.errorMessage}`);
    },
  });
}

// 터미널 Ctrl-C 는 프로세스 그룹 전체에 SIGINT 를 보내고, npm run 은 받은 신호를 자식에게 한 번 더 전달한다.
// 그래서 CLI 는 같은 신호를 거의 같은 순간 두 번 받는다. 첫 신호 뒤 이 창 안에 온 신호는 같은 Ctrl-C 로 보고 무시한다.
const DUPLICATE_SIGNAL_WINDOW_MS = 1500;
// 창 밖에서 다시 받으면(사람이 한 번 더 누름) 워커를 바로 죽인다. 그래도 이 시간 안에 정리가 끝나지 않으면 기록만 쓰고 끝낸다.
const FORCE_EXIT_AFTER_MS = 3000;

// 신호 처리기는 실행이 끝날 때까지 달아 둔다. 떼면 Node 기본 동작으로 돌아가 다음 신호에 정리 없이 죽는다.
// 첫 신호는 onStop(우아한 중단), 창 밖에서 다시 온 신호는 onForce(한 번만)를 부른다. 떼는 함수를 돌려준다.
function listenStopSignal({ signalSource, onStop, onForce, now = () => performance.now() }) {
  let firstSignalAt = null;
  let isForced = false;
  const handleSignal = (signalName) => {
    if (firstSignalAt === null) {
      firstSignalAt = now();
      onStop(signalName);
      return;
    }
    if (isForced || now() - firstSignalAt < DUPLICATE_SIGNAL_WINDOW_MS) return;
    isForced = true;
    onForce(signalName);
  };
  const handlerMap = new Map(STOP_SIGNAL_LIST.map((signalName) => [signalName, () => handleSignal(signalName)]));
  for (const [signalName, handler] of handlerMap) signalSource.on(signalName, handler);
  return () => {
    for (const [signalName, handler] of handlerMap) signalSource.off(signalName, handler);
  };
}

// 종료 코드를 돌려준다: 시작 전 점검 실패·영상 없음·영상 하나라도 실패면 1, 신호로 중단하면 128 + 신호 번호(SIGHUP 129, SIGINT 130, SIGTERM 143).
// workerPath·checkService·runVersion·checkTriggerAnalyzer·readFreeMemoryBytes·startTunnel·signalSource·exitProcess 는 테스트가
// 실제 워커·GPU 서비스·Kiwi 모델·남은 메모리·SSH·프로세스 신호 없이 돌리려고 바꿔 끼운다.
export async function runFactoryCli({
  argList, env = process.env, log = console, workerPath, checkService, runVersion, checkTriggerAnalyzer, readFreeMemoryBytes = os.freemem,
  startTunnel = startProductTunnel, signalSource = process,
  exitProcess = (exitCode) => process.exit(exitCode),
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
  // 이전 manifest 가 깨져 있으면 영상을 다 돌린 뒤가 아니라 지금 멈춘다. 이어 쓸 내용은 잠금을 잡은 뒤 다시 읽는다.
  readManifest({ outDir });

  const preflight = await runPreflight({ pipelineConfig, ffmpegPath, ffprobePath, checkService, runVersion, checkTriggerAnalyzer });
  const tunnel = await openGpuAccess({ preflight, env, pipelineConfig, checkService, startTunnel, log });
  if (preflight.problemList.length) {
    // 터널 모듈 오류 등 바깥 문구에는 주소가 실릴 수 있어 사용자 정보를 지운다.
    for (const problem of preflight.problemList) log.error(`[factory] 시작 전 점검 실패: ${redactUrlCredential(problem)}`);
    await tunnel?.stop();
    return 1;
  }
  // 워커마다 Kiwi 로 메모리를 더 쓴다. 남은 메모리가 적으면 경고만 한 줄 찍고 그대로 돈다.
  const memoryWarning = buildMemoryWarning({ workerCount: Math.min(options.concurrency, jobList.length), freeBytes: readFreeMemoryBytes() });
  if (memoryWarning) log.warn(memoryWarning);

  const runOptions = { ...options, input: path.resolve(options.input), out: outDir };
  // 끝난 결과를 다시 쓸지 견줄 코드 버전(제품·공장)과 결과 설정. manifest 에도 남긴다.
  const identity = readResultIdentity({ pipelineConfig });
  const { seeonMeet, factory } = identity.versionMap;
  const stopController = new AbortController();
  const forceController = new AbortController();
  let interruptedBy = null;
  let forceExitTimer = null;
  let lock = null;
  let writeFinalRecord = () => {};
  const toSignalExitCode = (signalName) => 128 + os.constants.signals[signalName];
  // 점검을 마친 뒤부터 실행이 끝날 때까지 신호를 받는다. 워커를 띄우기 전에 받아도 기록을 남기고 끝낸다.
  const stopListening = listenStopSignal({
    signalSource,
    onStop: (signalName) => {
      interruptedBy = signalName;
      log.error(`[factory] ${signalName} 받음 — 돌던 워커를 멈추고 기록을 남긴 뒤 끝낸다(${DUPLICATE_SIGNAL_WINDOW_MS / 1000}초 지나 한 번 더 보내면 워커를 바로 죽인다)`);
      stopController.abort(signalName);
    },
    onForce: (signalName) => {
      log.error(`[factory] ${signalName} 다시 받음 — 강제 종료: 워커를 바로 죽이고 기록만 남긴다`);
      forceController.abort(signalName);
      // 정리가 어딘가에서 멈춰도(터널 닫기 등) 기록을 쓰고 끝낸다.
      forceExitTimer = setTimeout(() => {
        writeFinalRecord();
        lock?.release();
        exitProcess(toSignalExitCode(interruptedBy));
      }, FORCE_EXIT_AFTER_MS);
      forceExitTimer.unref?.();
    },
  });
  let manifest;
  try {
    await fs.promises.mkdir(outDir, { recursive: true });
    try {
      lock = acquireRunLock({
        outDir, onTakeOver: (holder) => log.warn(`[factory] 낡은 잠금(pid ${holder.pid} · ${holder.startedAt} 시작, 프로세스 없음)을 가져간다 — 그 실행은 정리 없이 끝났다`),
      });
    } catch (error) {
      log.error(`[factory] ${error.message}`);
      return 1;
    }
    const previousManifest = readManifest({ outDir });
    const skippedJobList = options.isForced ? [] : selectSkippedJobList({ jobList, outDir, identity, log });
    const pendingJobList = jobList.filter((job) => !skippedJobList.includes(job));
    const startedAt = new Date().toISOString();
    const resultByStem = new Map();
    const buildCurrentManifest = (endedAt) => buildManifest({
      previousManifest, runOptions, seeonMeet, factory, resultConfig: identity.resultConfig,
      jobList, resultList: [...resultByStem.values()], skippedJobList, startedAt, endedAt, interruptedBy,
    });
    writeFinalRecord = () => {
      try {
        writeRunRecord({ outDir, manifest: buildCurrentManifest(new Date().toISOString()) });
      } catch (error) {
        log.warn(`[factory] 실행 기록 쓰기 실패: ${error.message}`);
      }
    };
    writeRunRecord({ outDir, manifest: buildCurrentManifest(null) });
    log.log(`[factory] 영상 ${jobList.length}개(건너뜀 ${skippedJobList.length}) · 동시 ${options.concurrency} · 출력 ${outDir}`);
    await runPendingJobList({
      pendingJobList, outDir, concurrency: options.concurrency, env, workerPath, log,
      videoTimeout: buildVideoTimeout({ timeoutMin: options.timeoutMin }), signal: stopController.signal, forceSignal: forceController.signal,
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
    lock?.release();
    await tunnel?.stop();
    clearTimeout(forceExitTimer);
    stopListening();
  }
  log.log(formatSummary(manifest));
  if (interruptedBy) return toSignalExitCode(interruptedBy);
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
    .catch((error) => { console.error(`[factory] ${redactUrlCredential(error.message)}`); process.exitCode = 1; });
}
