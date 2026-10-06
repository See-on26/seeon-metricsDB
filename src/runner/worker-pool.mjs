// src/runner/worker-pool.mjs
import fs from 'node:fs';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mapWithConcurrency } from '../util/map-with-concurrency.mjs';

const DEFAULT_WORKER_PATH = fileURLToPath(new URL('./video-worker.mjs', import.meta.url));

// 영상 하나 = 워커 하나. 콘솔 출력(제품 파이프라인 로그 포함)은 그대로 <영상>.log 로 간다.
export function forkVideoWorker({ job, outDir, logPath, env = process.env, workerPath = DEFAULT_WORKER_PATH, onProgress = () => {} }) {
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
  const promise = new Promise((resolve, reject) => {
    let outcome = null;
    child.on('message', (message) => {
      if (message?.type === 'progress') onProgress(message);
      if (message?.type === 'done') outcome = { result: message.result };
      if (message?.type === 'failed') outcome = { error: new Error(message.message) };
    });
    child.on('error', (error) => { outcome = outcome || { error }; });
    // close 는 프로세스 종료와 IPC 채널 닫힘을 모두 기다리므로 종료 직전에 보낸 done·failed 를 놓치지 않는다.
    child.on('close', (code, signal) => {
      fs.closeSync(logFd);
      if (outcome?.result) resolve(outcome.result);
      else reject(outcome?.error || new Error(`워커가 결과 없이 종료(코드 ${code ?? signal})`));
    });
  });
  child.send({ type: 'run', job, outDir });
  return { promise, kill: () => child.kill('SIGKILL') };
}

// 동시에 concurrency 개까지만 워커를 띄운다. 한 영상의 실패는 다른 영상에 영향이 없다. 결과는 입력 순서다.
export function runWorkerPool({ jobList, concurrency, startWorker, onEvent = () => {} }) {
  return mapWithConcurrency({
    itemList: jobList,
    concurrency,
    run: async (job) => {
      onEvent({ type: 'start', job });
      let result;
      try {
        result = await startWorker(job).promise;
      } catch (error) {
        result = { videoId: job.videoId, outStem: job.outStem, status: 'failed', errorMessage: error.message };
      }
      onEvent({ type: 'end', job, result });
      return result;
    },
  });
}
