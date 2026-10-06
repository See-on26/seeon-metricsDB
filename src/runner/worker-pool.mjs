// src/runner/worker-pool.mjs
import fs from 'node:fs';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mapWithConcurrency } from '../util/map-with-concurrency.mjs';

const DEFAULT_WORKER_PATH = fileURLToPath(new URL('./video-worker.mjs', import.meta.url));
// SIGTERM 뒤 워커가 띄운 ffmpeg 를 정리하고 끝날 틈. 그 안에 안 끝나면 SIGKILL.
const DEFAULT_KILL_GRACE_MS = 5000;
const MINUTE_MS = 60000;
// 영상 길이를 알기 전(준비 단계 포함)의 상한이자 상한의 바닥.
const DEFAULT_VIDEO_TIMEOUT_MS = 30 * MINUTE_MS;
// 영상 길이를 알면 길이 × 4 + 10분. 서비스가 느려도 실시간보다 빨리 도는 것이 보통이라 넉넉한 값이다.
const TIMEOUT_DURATION_FACTOR = 4;
const TIMEOUT_MARGIN_MS = 10 * MINUTE_MS;

// 영상 하나의 실제 시간 상한. --timeout-min 을 주면 영상마다 고정, 아니면 첫 진행 보고의 영상 길이로 다시 잰다.
export function buildVideoTimeout({ timeoutMin = null } = {}) {
  if (timeoutMin) return { timeoutMs: Math.round(timeoutMin * MINUTE_MS), resolveTimeoutMs: null };
  return {
    timeoutMs: DEFAULT_VIDEO_TIMEOUT_MS,
    resolveTimeoutMs: (durationMs) => durationMs * TIMEOUT_DURATION_FACTOR + TIMEOUT_MARGIN_MS,
  };
}

function formatLimit(limitMs) {
  return limitMs >= MINUTE_MS ? `${Math.round(limitMs / MINUTE_MS)}분` : `${Math.ceil(limitMs / 1000)}초`;
}

// 영상 하나 = 워커 하나. 콘솔 출력(제품 파이프라인 로그 포함)은 그대로 <영상>.log 로 간다.
// timeoutMs 를 넘기면(첫 진행 보고 뒤에는 resolveTimeoutMs(영상 길이) 와 큰 쪽, 상한은 줄지 않는다) 멈추고 시간 초과로 실패한다.
// 멈출 때는 SIGTERM 으로 정리할 틈을 주고 killGraceMs 뒤에도 살아 있으면 SIGKILL 한다.
export function forkVideoWorker({
  job, outDir, logPath, env = process.env, workerPath = DEFAULT_WORKER_PATH, onProgress = () => {},
  timeoutMs = null, resolveTimeoutMs = null, killGraceMs = DEFAULT_KILL_GRACE_MS,
}) {
  const logFd = fs.openSync(logPath, 'a');
  let child;
  try {
    child = fork(workerPath, [], {
      execArgv: ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'], env, stdio: ['ignore', logFd, logFd, 'ipc'],
    });
  } catch (error) {
    fs.closeSync(logFd);
    throw error;
  }
  const startedAt = Date.now();
  let limitMs = timeoutMs;
  let isLimitResolved = false;
  let stopReason = null;
  let isClosed = false;
  let timeoutTimer = null;
  let graceTimer = null;

  function stop(reason) {
    if (stopReason || isClosed) return;
    stopReason = reason;
    clearTimeout(timeoutTimer);
    child.kill('SIGTERM');
    graceTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
  }

  function armTimeout() {
    clearTimeout(timeoutTimer);
    if (!limitMs || stopReason) return;
    const limitAtArm = limitMs;
    timeoutTimer = setTimeout(() => stop(`시간 초과(${formatLimit(limitAtArm)}) — 워커를 멈췄다`), Math.max(0, startedAt + limitMs - Date.now()));
  }

  function resolveLimit(durationMs) {
    if (isLimitResolved || !resolveTimeoutMs || !Number.isFinite(durationMs)) return;
    isLimitResolved = true;
    const nextLimitMs = Math.max(limitMs || 0, resolveTimeoutMs(durationMs));
    if (nextLimitMs === limitMs) return;
    limitMs = nextLimitMs;
    armTimeout();
  }

  armTimeout();
  const promise = new Promise((resolve, reject) => {
    let outcome = null;
    child.on('message', (message) => {
      if (message?.type === 'progress') {
        resolveLimit(message.durationMs);
        onProgress(message);
      }
      if (message?.type === 'done') outcome = { result: message.result };
      if (message?.type === 'failed') outcome = { error: new Error(message.message) };
    });
    child.on('error', (error) => { outcome = outcome || { error }; });
    // close 는 프로세스 종료와 IPC 채널 닫힘을 모두 기다리므로 종료 직전에 보낸 done·failed 를 놓치지 않는다.
    child.on('close', (code, signal) => {
      isClosed = true;
      clearTimeout(timeoutTimer);
      clearTimeout(graceTimer);
      fs.closeSync(logFd);
      if (outcome?.result) resolve(outcome.result);
      else if (stopReason) reject(new Error(stopReason));
      else reject(outcome?.error || new Error(`워커가 결과 없이 종료(코드 ${code ?? signal})`));
    });
  });
  child.send({ type: 'run', job, outDir });
  return { promise, kill: ({ reason = '중단됨' } = {}) => stop(reason) };
}

// 동시에 concurrency 개까지만 워커를 띄운다. 한 영상의 실패는 다른 영상에 영향이 없다. 결과는 입력 순서다.
// signal 이 중단되면 돌던 워커를 '중단됨(<이유>)' 로 멈추고, 아직 시작하지 않은 영상은 띄우지 않고 결과를 null 로 둔다.
export async function runWorkerPool({ jobList, concurrency, startWorker, onEvent = () => {}, signal = null }) {
  const activeWorkerSet = new Set();
  const formatStopReason = () => `중단됨(${typeof signal.reason === 'string' ? signal.reason : '중단'})`;
  const stopActiveWorkers = () => {
    for (const worker of activeWorkerSet) worker.kill({ reason: formatStopReason() });
  };
  signal?.addEventListener('abort', stopActiveWorkers, { once: true });
  try {
    return await mapWithConcurrency({
      itemList: jobList,
      concurrency,
      run: async (job) => {
        if (signal?.aborted) return null;
        onEvent({ type: 'start', job });
        let result;
        try {
          const worker = startWorker(job);
          activeWorkerSet.add(worker);
          try {
            result = await worker.promise;
          } finally {
            activeWorkerSet.delete(worker);
          }
        } catch (error) {
          result = { videoId: job.videoId, outStem: job.outStem, status: 'failed', errorMessage: error.message };
        }
        onEvent({ type: 'end', job, result });
        return result;
      },
    });
  } finally {
    signal?.removeEventListener('abort', stopActiveWorkers);
  }
}
