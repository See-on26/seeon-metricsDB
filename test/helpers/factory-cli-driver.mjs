import { fileURLToPath } from 'node:url';
import { runFactoryCli } from '../../src/cli/factory-cli.mjs';

// 진짜 프로세스 신호를 시험하려고 CLI 를 따로 띄우는 진입점. 워커는 가짜 워커, 시작 전 점검은 대역이라 GPU·SSH 에 닿지 않는다.
// 신호 처리기는 실제 CLI 처럼 process 에 건다(signalSource 기본값).
const FAKE_WORKER_PATH = fileURLToPath(new URL('./fake-video-worker.mjs', import.meta.url));

runFactoryCli({
  argList: process.argv.slice(2),
  workerPath: FAKE_WORKER_PATH,
  checkService: async () => ({ isUp: true, detail: 'HTTP 405' }),
  runVersion: async () => Buffer.from('ok'),
  startTunnel: async () => { throw new Error('포트가 열려 있으면 터널을 열지 않는다'); },
})
  .then((exitCode) => { process.exitCode = exitCode; })
  .catch((error) => { console.error(`[driver] ${error.stack || error.message}`); process.exitCode = 1; });
