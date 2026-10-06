import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleepReal } from 'node:timers/promises';
import { waitRealUntil } from './helpers/real-wait.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const DRIVER_PATH = fileURLToPath(new URL('./helpers/factory-cli-driver.mjs', import.meta.url));
const NODE_FLAG = '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON';
const LOCK_FILE_NAME = '.factory.lock';
// GPU 실서비스 포트(8801–8804)에 닿지 않게 주소는 쓰지 않는 포트로 둔다. 점검은 드라이버의 대역이 한다.
const DRIVER_ENV = {
  PATH: process.env.PATH, HOME: process.env.HOME, AWS_BEARER_TOKEN_BEDROCK: 'test-token',
  SEEON_VLM_URL: 'http://127.0.0.1:9/v1/chat/completions', SEEON_ASR_URL: 'http://127.0.0.1:9/asr',
  SEEON_TTS_URL: 'http://127.0.0.1:9/tts', SEEON_TTS_LONG_URL: 'http://127.0.0.1:9/tts-long', SEEON_EMBED_URL: 'http://127.0.0.1:9/embed',
};
// 터미널 Ctrl-C 와 npm 이 전달한 SIGINT 사이의 간격(같은 Ctrl-C 로 보는 창보다 훨씬 짧다).
const NPM_FORWARD_GAP_MS = 10;

function prepareRun(nameList) {
  const dirPath = makeTempDir('factory-signal-');
  const inputDir = path.join(dirPath, 'input');
  fs.mkdirSync(inputDir);
  for (const name of nameList) fs.writeFileSync(path.join(inputDir, name), '');
  return { dirPath, inputDir, outDir: path.join(dirPath, 'out') };
}

// 새 프로세스 그룹으로 띄워(detached) 그룹에 보내는 신호가 터미널 Ctrl-C 처럼 CLI·워커 모두에 가고 테스트 러너에는 가지 않게 한다.
// 출력 파이프는 그룹에서 이 파이프를 쥔 프로세스(npm·CLI)가 모두 끝나야 닫힌다.
function spawnInGroup(t, { command, argList, cwd }) {
  const child = spawn(command, argList, { detached: true, env: DRIVER_ENV, stdio: ['ignore', 'pipe', 'pipe'], cwd });
  const output = { text: '' };
  child.stdout.on('data', (chunk) => { output.text += chunk; });
  child.stderr.on('data', (chunk) => { output.text += chunk; });
  const exited = new Promise((resolve) => { child.once('exit', (code, signal) => resolve({ code, signal })); });
  const closed = new Promise((resolve) => { child.stdout.once('close', resolve); });
  t.after(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 이미 끝난 그룹 */ }
  });
  return { child, output, exited, closed };
}

// 그룹이 이미 끝났으면 보낼 곳이 없을 뿐이다(ESRCH, macOS 는 좀비만 남은 그룹이면 EPERM). 결과는 뒤의 단언이 본다.
function signalGroup({ child, signalName }) {
  try {
    process.kill(-child.pid, signalName);
  } catch (error) {
    if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error;
  }
}

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const readLog = ({ outDir, outStem }) => {
  const logPath = path.join(outDir, `${outStem}.log`);
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
};

// 워커가 run 을 받아 처리기를 단 뒤(로그에 시작 줄이 생긴 뒤) 신호를 보낸다.
function waitWorkersStarted({ outDir, outStemList }) {
  return waitRealUntil(() => outStemList.every((outStem) => readLog({ outDir, outStem }).includes(`${outStem} 시작`)), { limitMs: 10000 });
}

function assertInterruptedManifest({ outDir, output }) {
  const manifest = readJson(path.join(outDir, 'manifest.json'));
  assert.equal(manifest.interruptedBy, 'SIGINT', output.text);
  assert.ok(manifest.endedAt, '정리를 마치고 끝난 시각을 남긴다');
  assert.deepEqual(manifest.videoList.map((video) => [video.videoId, video.status, video.errorMessage]), [
    ['a-linger', 'failed', '중단됨(SIGINT)'], ['b-linger', 'failed', '중단됨(SIGINT)'], ['c', 'not_run', undefined],
  ]);
  assert.match(fs.readFileSync(path.join(outDir, 'summary.txt'), 'utf8'), /SIGINT 로 중단/);
  assert.equal(fs.existsSync(path.join(outDir, LOCK_FILE_NAME)), false, '중단돼도 잠금을 푼다');
}

test('진짜 프로세스: 그룹에 SIGINT 가 연달아 두 번(터미널 Ctrl-C + npm 전달) 와도 워커를 SIGTERM 으로 순서대로 멈추고 중단을 기록한 뒤 130 으로 끝난다', { timeout: 30000 }, async (t) => {
  const { inputDir, outDir } = prepareRun(['a-linger.mp4', 'b-linger.mp4', 'c.mp4']);
  const run = spawnInGroup(t, { command: process.execPath, argList: [NODE_FLAG, DRIVER_PATH, '--input', inputDir, '--out', outDir, '--concurrency', '2'] });
  assert.ok(await waitWorkersStarted({ outDir, outStemList: ['a-linger', 'b-linger'] }), run.output.text);
  signalGroup({ child: run.child, signalName: 'SIGINT' });
  await sleepReal(NPM_FORWARD_GAP_MS);
  signalGroup({ child: run.child, signalName: 'SIGINT' });
  assert.deepEqual(await run.exited, { code: 130, signal: null }, run.output.text);
  assertInterruptedManifest({ outDir, output: run.output });
  for (const outStem of ['a-linger', 'b-linger']) {
    assert.match(readLog({ outDir, outStem }), /SIGTERM 받음/, `${outStem}: 터미널 SIGINT 로 죽지 않고 워커 풀이 보낸 SIGTERM 으로 멈춘다`);
  }
  assert.equal(fs.existsSync(path.join(outDir, 'c.log')), false, '중단 뒤에는 새 워커를 띄우지 않는다');
});

test('진짜 프로세스: npm exec -c(npm run 과 같은 신호 전달) 아래에서 Ctrl-C 한 번에도 정리하고 manifest 에 중단을 남긴다', { timeout: 30000 }, async (t) => {
  const { dirPath, inputDir, outDir } = prepareRun(['a-linger.mp4', 'b-linger.mp4', 'c.mp4']);
  const commandText = [process.execPath, NODE_FLAG, DRIVER_PATH, '--input', inputDir, '--out', outDir, '--concurrency', '2']
    .map((part) => `'${part}'`).join(' ');
  const run = spawnInGroup(t, { command: 'npm', argList: ['exec', '--offline', '-c', commandText], cwd: dirPath });
  assert.ok(await waitWorkersStarted({ outDir, outStemList: ['a-linger', 'b-linger'] }), run.output.text);
  signalGroup({ child: run.child, signalName: 'SIGINT' });
  await run.closed;
  assertInterruptedManifest({ outDir, output: run.output });
  assert.match(run.output.text, /\[factory\] SIGINT 받음/);
});

test('진짜 프로세스: 정리 중에 시간을 두고 신호를 한 번 더 보내면 워커 유예를 기다리지 않고 바로 죽이되 중단 기록은 남긴다', { timeout: 30000 }, async (t) => {
  const { inputDir, outDir } = prepareRun(['a-stubborn.mp4', 'b-stubborn.mp4']);
  const run = spawnInGroup(t, { command: process.execPath, argList: [NODE_FLAG, DRIVER_PATH, '--input', inputDir, '--out', outDir, '--concurrency', '2'] });
  assert.ok(await waitWorkersStarted({ outDir, outStemList: ['a-stubborn', 'b-stubborn'] }), run.output.text);
  const firstSignalAt = performance.now();
  signalGroup({ child: run.child, signalName: 'SIGINT' });
  // 같은 Ctrl-C 로 보는 창이 지난 뒤 사람이 다시 누른 것처럼 보낸다. SIGTERM 을 무시하는 워커라 강제가 없으면 유예(5초) 뒤에야 끝난다.
  await sleepReal(2000);
  signalGroup({ child: run.child, signalName: 'SIGINT' });
  assert.deepEqual(await run.exited, { code: 130, signal: null }, run.output.text);
  assert.ok(performance.now() - firstSignalAt < 4500, `강제 종료가 유예를 기다렸다: ${Math.round(performance.now() - firstSignalAt)}ms`);
  const manifest = readJson(path.join(outDir, 'manifest.json'));
  assert.equal(manifest.interruptedBy, 'SIGINT');
  assert.ok(manifest.endedAt);
  assert.deepEqual(manifest.videoList.map((video) => [video.videoId, video.status, video.errorMessage]), [
    ['a-stubborn', 'failed', '중단됨(SIGINT)'], ['b-stubborn', 'failed', '중단됨(SIGINT)'],
  ]);
  assert.match(run.output.text, /강제/);
  assert.equal(fs.existsSync(path.join(outDir, LOCK_FILE_NAME)), false, '강제 종료여도 잠금을 푼다');
});
