import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockServices } from './helpers/mock-services.mjs';
import { createTestClip } from './helpers/media-fixtures.mjs';
import { waitRealUntil } from './helpers/real-wait.mjs';
import { resolveFfmpegPaths } from '../src/media/ffmpeg.mjs';

const { ffprobePath } = resolveFfmpegPaths({ env: process.env });
const WORKER_PATH = fileURLToPath(new URL('../src/runner/video-worker.mjs', import.meta.url));
const mock = await startMockServices();
after(() => mock.close());

// Bedrock 토큰 없이 돌린다: 탐지 판정(라우터·무발화·지시)은 mock VLM 주소의 GPU 판정, 틈 추론은 규칙 폴백(제품 동작). 실서비스 포트는 쓰지 않는다.
function runWorker({ job, outDir }) {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER_PATH, [], {
      execArgv: ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...mock.urlEnv },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let result = null;
    let logText = '';
    child.stdout.on('data', (chunk) => { logText += chunk; });
    child.stderr.on('data', (chunk) => { logText += chunk; });
    child.on('message', (message) => {
      if (message.type === 'done') result = message.result;
      if (message.type === 'failed') result = { status: 'failed', message: message.message };
    });
    child.on('exit', (code) => (result ? resolve({ ...result, logText, code }) : reject(new Error(`워커가 결과 없이 끝남(${code}): ${logText.slice(-1500)}`))));
    child.send({ type: 'run', job, outDir });
  });
}

const readMp3Ms = (filePath) => Number(execFileSync(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath]).toString()) * 1000;

test('합성 발표 영상 하나를 워커로 끝까지 돌리면 mp3·json 이 나오고 길이 공식이 맞는다', { timeout: 180000 }, async () => {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-e2e-'));
  const filePath = await createTestClip({
    dirPath, fileName: 'deck.mp4', width: 640, height: 360,
    colorTimeline: [['0x3050a0', 12], ['0xa05030', 12]], audioExpr: '0.4*sin(2*PI*220*t)*lt(mod(t,8),6)',
  });
  const outDir = path.join(dirPath, 'out');
  const countBefore = { ...mock.state.callCountMap };
  const result = await runWorker({ job: { videoId: 'deck', filePath, outStem: 'deck', language: 'ko', isPageTransitionIncluded: false }, outDir });
  const countAfter = { ...mock.state.callCountMap };
  assert.equal(result.status, 'done', result.logText.slice(-2000));
  const report = JSON.parse(fs.readFileSync(path.join(outDir, 'deck_SEEON_AD.json'), 'utf8'));
  assert.equal(report.isComplete, true);
  assert.ok(report.adList.some((ad) => ad.type === 'deixis'), JSON.stringify(report.droppedList));
  for (const ad of report.adList) assert.ok(fs.existsSync(path.join(outDir, ad.wavFile)));
  const mp3Ms = readMp3Ms(path.join(outDir, 'deck_SEEON_AD.mp3'));
  assert.ok(Math.abs(mp3Ms - report.output.timelineDurationMs) < 150, `mp3 ${mp3Ms} / 타임라인 ${report.output.timelineDurationMs}`);
  const expectedMs = report.output.sourceMediaMs + report.output.adTotalMs + report.output.silenceTotalMs - report.output.recoveredMs;
  assert.ok(Math.abs(mp3Ms - expectedMs) <= 1000);
  assert.ok(Math.abs(report.output.sourceMediaMs - 24000) < 100, '원음을 끝까지 다 틀었다');
  assert.ok(report.stats.serviceMap.asr.count >= 3);
  // 판정 요청은 VLM 주소로 가지만 VLM 통계를 부풀리지 않는다. mock 이 받은 수(따로 가른 것)와 기록이 같아야 한다.
  const { serviceMap, judgeSourceCountMap } = report.stats;
  assert.ok(serviceMap.judge.count >= 1, JSON.stringify(serviceMap));
  assert.equal(serviceMap.judge.count, countAfter.judge - countBefore.judge);
  assert.equal(serviceMap.vlm.count, countAfter.vlm - countBefore.vlm);
  const judgeGpuCount = Object.values(judgeSourceCountMap).reduce((sum, countMap) => sum + countMap.gpu, 0);
  assert.equal(judgeGpuCount, serviceMap.judge.count, JSON.stringify(judgeSourceCountMap));
  assert.ok(judgeSourceCountMap.router.gpu >= 1, '지시 해설은 통합 라우터 GPU 판정을 거친다');
  assert.ok(Object.values(judgeSourceCountMap).every((countMap) => countMap.bedrock === 0 && countMap.error === 0));
  const { modelConfig } = report.config;
  assert.deepEqual([modelConfig.judgeBackend, modelConfig.judgeGpuUrl, modelConfig.judgeGpuModel], ['gpu', modelConfig.vlmUrl, modelConfig.vlmModel]);
  assert.ok(modelConfig.judgeModelId, 'GPU 가 실패하면 넘어갈 Bedrock 판정 모델');
  assert.ok(fs.readdirSync(path.join(outDir, 'deck')).some((name) => /^pipeline-\d+\.jsonl$/.test(name)));
  assert.ok(report.droppedList.filter((drop) => drop.type === 'page_transition').every((drop) => drop.reason === 'feature_off'), '평가 프리셋: 전환 고지는 생성만');
});

test('오디오 트랙 없는 영상도 끝까지 돌고 AD 0개로 끝난다', { timeout: 120000 }, async () => {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-e2e-silent-'));
  const filePath = await createTestClip({ dirPath, fileName: 'mute.mp4', colorTimeline: [['gray', 6]], hasAudio: false });
  const outDir = path.join(dirPath, 'out');
  const result = await runWorker({ job: { videoId: 'mute', filePath, outStem: 'mute', language: 'auto', isPageTransitionIncluded: false }, outDir });
  assert.equal(result.status, 'done', result.logText.slice(-2000));
  const report = JSON.parse(fs.readFileSync(path.join(outDir, 'mute_SEEON_AD.json'), 'utf8'));
  assert.equal(report.adList.length, 0);
  assert.ok(Math.abs(report.output.sourceMediaMs - 6000) < 100);
  assert.ok(Math.abs(readMp3Ms(path.join(outDir, 'mute_SEEON_AD.mp3')) - report.output.timelineDurationMs) < 150);
});

function listProcessByArg(text) {
  return execFileSync('ps', ['-ax', '-o', 'pid=,command=']).toString().split('\n').filter((line) => line.includes(text) && !line.includes(' ps '));
}

test('워커는 SIGTERM 을 받으면 띄운 ffmpeg·ffprobe 를 죽이고 143 으로 끝난다', { timeout: 60000 }, async () => {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-e2e-sigterm-'));
  // 쓰는 쪽이 없는 FIFO 를 영상으로 주면 ffprobe 가 열다가 멈춘다.
  const fifoPath = path.join(dirPath, 'stuck.mp4');
  execFileSync('mkfifo', [fifoPath]);
  const child = fork(WORKER_PATH, [], {
    execArgv: ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'], env: { PATH: process.env.PATH, HOME: process.env.HOME, ...mock.urlEnv }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exitPromise = new Promise((resolve) => { child.once('exit', (code, signal) => resolve({ code, signal })); });
  child.send({ type: 'run', job: { videoId: 'stuck', filePath: fifoPath, outStem: 'stuck', language: 'ko', isPageTransitionIncluded: false }, outDir: path.join(dirPath, 'out') });
  assert.ok(await waitRealUntil(() => listProcessByArg(fifoPath).length > 0, { limitMs: 10000, pollMs: 50 }), 'ffprobe 가 떠 있어야 한다');
  child.kill('SIGTERM');
  assert.deepEqual(await exitPromise, { code: 143, signal: null });
  assert.ok(await waitRealUntil(() => listProcessByArg(fifoPath).length === 0, { limitMs: 3000, pollMs: 50 }), `남은 자식: ${listProcessByArg(fifoPath).join(' | ')}`);
});

// 쓰는 쪽이 없는 FIFO 를 영상으로 준 워커를 띄워, ffprobe 가 열다가 멈춘 상태를 만든다.
async function startStuckWorker({ t, name }) {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), `factory-e2e-${name}-`));
  t.after(() => fs.rmSync(dirPath, { recursive: true, force: true }));
  const fifoPath = path.join(dirPath, 'stuck.mp4');
  execFileSync('mkfifo', [fifoPath]);
  const child = fork(WORKER_PATH, [], {
    execArgv: ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'], env: { PATH: process.env.PATH, HOME: process.env.HOME, ...mock.urlEnv }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exitPromise = new Promise((resolve) => { child.once('exit', (code, signal) => resolve({ code, signal })); });
  child.send({ type: 'run', job: { videoId: 'stuck', filePath: fifoPath, outStem: 'stuck', language: 'ko', isPageTransitionIncluded: false }, outDir: path.join(dirPath, 'out') });
  assert.ok(await waitRealUntil(() => listProcessByArg(fifoPath).length > 0, { limitMs: 10000, pollMs: 50 }), 'ffprobe 가 떠 있어야 한다');
  return { child, fifoPath, exitPromise };
}

test('워커는 터미널 Ctrl-C 의 SIGINT 로 죽지 않고, 부모가 보낸 SIGTERM 에 정리하고 끝난다', { timeout: 60000 }, async (t) => {
  const { child, fifoPath, exitPromise } = await startStuckWorker({ t, name: 'sigint' });
  let exitState = null;
  exitPromise.then((state) => { exitState = state; });
  child.kill('SIGINT');
  assert.equal(await waitRealUntil(() => exitState !== null, { limitMs: 500, pollMs: 20 }), false, `SIGINT 에 끝나면 안 된다: ${JSON.stringify(exitState)}`);
  child.kill('SIGTERM');
  assert.deepEqual(await exitPromise, { code: 143, signal: null });
  assert.ok(await waitRealUntil(() => listProcessByArg(fifoPath).length === 0, { limitMs: 3000, pollMs: 50 }), `남은 자식: ${listProcessByArg(fifoPath).join(' | ')}`);
});

test('워커는 부모와 IPC 가 끊기면(부모가 죽음) 띄운 ffprobe 를 죽이고 스스로 끝난다', { timeout: 60000 }, async (t) => {
  const { child, fifoPath, exitPromise } = await startStuckWorker({ t, name: 'disconnect' });
  child.disconnect();
  assert.deepEqual(await exitPromise, { code: 1, signal: null });
  assert.ok(await waitRealUntil(() => listProcessByArg(fifoPath).length === 0, { limitMs: 3000, pollMs: 50 }), `남은 자식: ${listProcessByArg(fifoPath).join(' | ')}`);
});
