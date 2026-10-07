import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFactoryCli } from '../src/cli/factory-cli.mjs';
import { readResultIdentity } from '../src/runner/result-identity.mjs';
import { loadPipelineConfig } from '../src/product/product-loader.mjs';
import { WORK_DIR_MARKER_NAME } from '../src/runner/work-dir.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const FAKE_WORKER_PATH = fileURLToPath(new URL('./helpers/fake-video-worker.mjs', import.meta.url));
// GPU 실서비스 포트(8801–8804)에 닿지 않게 모든 주소를 쓰지 않는 포트로 두고, 포트 점검은 대역으로 바꾼다.
const BASE_ENV = {
  PATH: process.env.PATH, HOME: process.env.HOME, AWS_BEARER_TOKEN_BEDROCK: 'test-token',
  SEEON_VLM_URL: 'http://127.0.0.1:9/v1/chat/completions', SEEON_ASR_URL: 'http://127.0.0.1:9/asr',
  SEEON_TTS_URL: 'http://127.0.0.1:9/tts', SEEON_TTS_LONG_URL: 'http://127.0.0.1:9/tts-long', SEEON_EMBED_URL: 'http://127.0.0.1:9/embed',
};
const GIB = 1024 ** 3;
const SERVICE_UP = { isUp: true, detail: 'HTTP 405' };
const SERVICE_DOWN = { isUp: false, detail: '연결 거부(ECONNREFUSED)' };
const PASSING_PREFLIGHT = {
  checkService: async () => SERVICE_UP,
  runVersion: async () => Buffer.from('ok'),
  checkTriggerAnalyzer: async () => [],
  readFreeMemoryBytes: () => 64 * GIB,
  startTunnel: async () => assert.fail('포트가 열려 있으면 터널을 열지 않는다'),
};

const makeDir = (name) => makeTempDir(`factory-cli-${name}-`);

function makeInputDir(nameList) {
  const dirPath = makeDir('input');
  for (const name of nameList) fs.writeFileSync(path.join(dirPath, name), '');
  return dirPath;
}

function createLogCollector({ onLine = () => {} } = {}) {
  const lineList = [];
  const push = (...partList) => {
    const line = partList.join(' ');
    lineList.push(line);
    onLine(line);
  };
  return { lineList, log: { log: push, error: push, warn: push } };
}

// 가짜 워커가 남기는 것과 같은 모양의 끝난 결과(mp3 + isComplete JSON)를 지금 코드 버전·결과 설정으로 미리 둔다.
function writeDonePair({ outDir, outStem, videoId, filePath, language = 'auto', isPageTransitionIncluded = false }) {
  const { versionMap, resultConfig } = readResultIdentity({ pipelineConfig: loadPipelineConfig().readPipelineConfig(BASE_ENV) });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${outStem}_SEEON_AD.mp3`), 'old mp3');
  fs.writeFileSync(path.join(outDir, `${outStem}_SEEON_AD.json`), JSON.stringify({
    isComplete: true, video: { videoId, file: filePath, language }, ...versionMap, config: { isPageTransitionIncluded, resultConfig },
  }));
}

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const countStart = ({ outDir, outStem }) => (fs.readFileSync(path.join(outDir, `${outStem}.log`), 'utf8').match(/\[fake-worker\] .* 시작/g) || []).length;

test('CLI: 남은 메모리가 (동시에 돌 워커 수) × 1GB 보다 적으면 Kiwi 메모리 경고를 한 줄 찍고 그대로 진행한다', async () => {
  const inputDir = makeInputDir(['a.mp4', 'd.mov']);
  const outDir = path.join(makeDir('memory'), 'run');
  const runWithFreeMemory = async (freeBytes) => {
    const { lineList, log } = createLogCollector();
    const exitCode = await runFactoryCli({
      argList: ['--input', inputDir, '--out', outDir, '--concurrency', '3', '--force'], env: BASE_ENV, log, workerPath: FAKE_WORKER_PATH,
      ...PASSING_PREFLIGHT, readFreeMemoryBytes: () => freeBytes,
    });
    return { exitCode, warningList: lineList.filter((line) => line.includes('남은 메모리')) };
  };
  const low = await runWithFreeMemory(1.5 * GIB);
  assert.equal(low.exitCode, 0, '경고만 하고 실패로 만들지 않는다');
  assert.deepEqual(low.warningList, [
    '[factory] ⚠ 남은 메모리 1.5GB 가 동시에 돌 워커 2개 × 1GB 보다 적다 — 워커마다 한국어 트리거 형태소 분석기(Kiwi)로 약 0.85GB 를 더 쓴다. 느려지거나 메모리가 모자라면 --concurrency 를 낮춘다',
  ]);
  assert.deepEqual((await runWithFreeMemory(2 * GIB)).warningList, [], '영상 수가 동시 수보다 적으면 영상 수만큼만 본다');
});

test('CLI: 영상마다 워커를 띄워 manifest·summary 를 쓰고, 실패가 있으면 종료 코드 1, 다시 돌리면 끝난 영상만 건너뛴다', async () => {
  const inputDir = makeInputDir(['a.mp4', 'b-fail.mp4', 'c-crash.mp4', 'd.mov', 'notes.txt']);
  const outDir = path.join(makeDir('out'), 'run');
  const { lineList, log } = createLogCollector();
  const exitCode = await runFactoryCli({
    argList: ['--input', inputDir, '--out', outDir, '--concurrency', '2', '--language', 'en', '--include-page-transition'],
    env: BASE_ENV, log, workerPath: FAKE_WORKER_PATH, ...PASSING_PREFLIGHT,
  });
  assert.equal(exitCode, 1);
  const manifest = readJson(path.join(outDir, 'manifest.json'));
  assert.deepEqual(manifest.videoList.map((video) => [video.videoId, video.status]), [
    ['a', 'done'], ['b-fail', 'failed'], ['c-crash', 'failed'], ['d', 'done'],
  ]);
  assert.deepEqual(manifest.counts, { total: 4, done: 2, failed: 2, skipped: 0 });
  assert.equal(manifest.videoList[1].errorMessage, 'b-fail 영상 스트림이 없다');
  assert.match(manifest.videoList[2].errorMessage, /결과 없이 종료.*137/);
  assert.equal(manifest.videoList[0].adCount, 2);
  assert.equal(manifest.videoList[0].filePath, path.join(inputDir, 'a.mp4'));
  assert.match(manifest.seeonMeet.commit, /^[0-9a-f]{40}$/);
  assert.equal(manifest.runOptions.concurrency, 2);
  assert.equal(manifest.runOptions.language, 'en');
  assert.equal(manifest.runOptions.input, inputDir);
  assert.equal(manifest.runOptions.out, outDir);
  assert.equal(manifest.runOptions.isPageTransitionIncluded, true);
  const summary = fs.readFileSync(path.join(outDir, 'summary.txt'), 'utf8');
  assert.match(summary, /영상 4 · 완료 2 · 실패 2 · 건너뜀 0/);
  assert.match(summary, /b-fail: b-fail 영상 스트림이 없다/);
  assert.match(fs.readFileSync(path.join(outDir, 'a.log'), 'utf8'), /\[fake-worker\] a 시작 · 언어 en · 전환 true/);
  assert.match(fs.readFileSync(path.join(outDir, 'b-fail.log'), 'utf8'), /\[fake-worker\] b-fail 실패/);
  assert.ok(lineList.includes('[factory] a 영상 10/60초 · AD 1'), lineList.join('\n'));
  assert.ok(lineList.some((line) => /^\[factory\] ✖ \[\d\/4\] c-crash 워커가 결과 없이 종료\(코드 137\)$/.test(line)), lineList.join('\n'));
  assert.ok(lineList.some((line) => /^\[factory\] ✔ \[\d\/4\] a AD 2개 · 1초$/.test(line)), lineList.join('\n'));

  const rerun = createLogCollector();
  assert.equal(await runFactoryCli({
    argList: ['--input', inputDir, '--out', outDir, '--language', 'en', '--include-page-transition'], env: BASE_ENV, log: rerun.log, workerPath: FAKE_WORKER_PATH, ...PASSING_PREFLIGHT,
  }), 1);
  const rerunManifest = readJson(path.join(outDir, 'manifest.json'));
  assert.deepEqual(rerunManifest.counts, { total: 4, done: 2, failed: 2, skipped: 2 });
  assert.deepEqual(rerunManifest.videoList[0], { ...manifest.videoList[0], isSkipped: true }, '건너뛴 영상은 그 결과를 만든 이전 실행의 기록을 그대로 둔다');
  assert.equal(countStart({ outDir, outStem: 'a' }), 1, '끝난 영상은 다시 돌리지 않는다');
  assert.equal(countStart({ outDir, outStem: 'b-fail' }), 2, '실패한 영상은 다시 돈다');
  assert.ok(rerun.lineList.some((line) => line.includes('영상 4개(건너뜀 2)')), rerun.lineList.join('\n'));

  assert.equal(await runFactoryCli({
    argList: ['--input', inputDir, '--out', outDir, '--force', '--limit', '1'], env: BASE_ENV, log: createLogCollector().log, workerPath: FAKE_WORKER_PATH, ...PASSING_PREFLIGHT,
  }), 0);
  assert.equal(countStart({ outDir, outStem: 'a' }), 2, '--force 면 끝난 영상도 다시 돈다');
  assert.deepEqual(readJson(path.join(outDir, 'manifest.json')).counts, { total: 1, done: 1, failed: 0, skipped: 0 });
});

test('CLI: 목록 JSON 의 같은 이름 영상은 출력 이름을 나눠 둘 다 남긴다', async () => {
  const dirPath = makeDir('list');
  const listPath = path.join(dirPath, 'list.json');
  fs.writeFileSync(listPath, JSON.stringify({ videoList: [{ videoId: 'talk', file: 'x/talk.mp4' }, { videoId: 'talk', file: 'y/talk.mp4', language: 'ko' }] }));
  const outDir = path.join(dirPath, 'out');
  assert.equal(await runFactoryCli({
    argList: ['--input', listPath, '--out', outDir], env: BASE_ENV, log: createLogCollector().log, workerPath: FAKE_WORKER_PATH, ...PASSING_PREFLIGHT,
  }), 0);
  for (const outStem of ['talk', 'talk-2']) assert.ok(fs.existsSync(path.join(outDir, `${outStem}_SEEON_AD.mp3`)), outStem);
  assert.deepEqual(readJson(path.join(outDir, 'manifest.json')).videoList.map((video) => [video.outStem, video.language, video.status]), [
    ['talk', 'auto', 'done'], ['talk-2', 'ko', 'done'],
  ]);
});

test('CLI: GPU 서비스가 HTTP 로 답하지 않고 터널도 못 열면 이유를 찍고 워커 없이 종료 코드 1', async () => {
  const inputDir = makeInputDir(['a.mp4']);
  const outDir = path.join(makeDir('closed'), 'run');
  const { lineList, log } = createLogCollector();
  let tunnelCallCount = 0;
  const exitCode = await runFactoryCli({
    argList: ['--input', inputDir, '--out', outDir], env: BASE_ENV, log, workerPath: FAKE_WORKER_PATH,
    checkService: async ({ url }) => (url.startsWith('http://127.0.0.1:9/') ? SERVICE_DOWN : SERVICE_UP),
    runVersion: async () => Buffer.from('ok'),
    checkTriggerAnalyzer: async () => [],
    readFreeMemoryBytes: () => 64 * GIB,
    startTunnel: async () => { tunnelCallCount += 1; return null; },
  });
  assert.equal(exitCode, 1);
  assert.equal(tunnelCallCount, 1);
  const downText = ['VLM', 'ASR', 'TTS', 'TTS_LONG', 'EMBED'].map((label) => `${label} 127.0.0.1:9 연결 거부(ECONNREFUSED)`).join(', ');
  assert.ok(lineList.includes(`[factory] GPU 서비스 응답 없음(${downText}) — 제품 터널 모듈로 연결을 시도한다`), lineList.join('\n'));
  assert.ok(lineList.includes(`[factory] 시작 전 점검 실패: GPU 서비스에 닿지 못했다: ${downText}`), lineList.join('\n'));
  assert.equal(fs.existsSync(outDir), false, '점검에 실패하면 출력 폴더를 만들지 않는다');
});

test('CLI: 터널이 열리다 실패하면 그 이유도 점검 실패로 찍는다', async () => {
  const { lineList, log } = createLogCollector();
  const exitCode = await runFactoryCli({
    argList: ['--input', makeInputDir(['a.mp4']), '--out', path.join(makeDir('tunnel-error'), 'run')], env: BASE_ENV, log, workerPath: FAKE_WORKER_PATH,
    checkService: async () => SERVICE_DOWN, runVersion: async () => Buffer.from('ok'),
    checkTriggerAnalyzer: async () => [],
    readFreeMemoryBytes: () => 64 * GIB,
    startTunnel: async () => { throw new Error('GPU 터널이 제때 연결되지 않았다'); },
  });
  assert.equal(exitCode, 1);
  assert.ok(lineList.includes('[factory] 시작 전 점검 실패: GPU 터널이 제때 연결되지 않았다'), lineList.join('\n'));

  const secret = createLogCollector();
  assert.equal(await runFactoryCli({
    argList: ['--input', makeInputDir(['a.mp4']), '--out', path.join(makeDir('tunnel-secret'), 'run')], env: BASE_ENV, log: secret.log, workerPath: FAKE_WORKER_PATH,
    checkService: async () => SERVICE_DOWN, runVersion: async () => Buffer.from('ok'),
    checkTriggerAnalyzer: async () => [],
    readFreeMemoryBytes: () => 64 * GIB,
    startTunnel: async () => { throw new Error('원격 주소 http://user:secretpw@gpu.local:8801 로 터널을 열지 못했다'); },
  }), 1);
  assert.ok(secret.lineList.includes('[factory] 시작 전 점검 실패: 원격 주소 http://gpu.local:8801 로 터널을 열지 못했다'), secret.lineList.join('\n'));
  assert.equal(secret.lineList.join('\n').includes('secretpw'), false);
});

test('CLI: 닫힌 포트를 제품 터널로 열면 다시 점검해 돌리고, 끝나면 터널을 닫는다', async () => {
  const inputDir = makeInputDir(['a.mp4']);
  const outDir = path.join(makeDir('tunnel'), 'run');
  let isTunnelOpen = false;
  let stopCount = 0;
  let tunnelEnv = null;
  const exitCode = await runFactoryCli({
    argList: ['--input', inputDir, '--out', outDir], env: { ...BASE_ENV, SEEON_GPU_SSH_KEY: '/keys/app' }, log: createLogCollector().log, workerPath: FAKE_WORKER_PATH,
    checkService: async () => (isTunnelOpen ? SERVICE_UP : SERVICE_DOWN), runVersion: async () => Buffer.from('ok'),
    checkTriggerAnalyzer: async () => [],
    readFreeMemoryBytes: () => 64 * GIB,
    startTunnel: async ({ env, pipelineConfig }) => {
      tunnelEnv = { key: env.SEEON_GPU_SSH_KEY, asrUrl: pipelineConfig.asrUrl };
      isTunnelOpen = true;
      return { stop: async () => { stopCount += 1; } };
    },
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(tunnelEnv, { key: '/keys/app', asrUrl: 'http://127.0.0.1:9/asr' });
  assert.equal(stopCount, 1);
  assert.equal(readJson(path.join(outDir, 'manifest.json')).counts.done, 1);
});

test('CLI: 터널이 열렸는데도 서비스가 답하지 않으면(원격 주소·터널 뒤 서비스 죽음 등) 점검 실패로 터널을 닫고 종료 코드 1', async () => {
  let stopCount = 0;
  const { lineList, log } = createLogCollector();
  const exitCode = await runFactoryCli({
    argList: ['--input', makeInputDir(['a.mp4']), '--out', path.join(makeDir('tunnel-still-closed'), 'run')], env: BASE_ENV, log, workerPath: FAKE_WORKER_PATH,
    checkService: async ({ url }) => (url.includes(':9/') ? { isUp: false, detail: '연결이 끊김(ECONNRESET)' } : SERVICE_UP), runVersion: async () => Buffer.from('ok'),
    checkTriggerAnalyzer: async () => [],
    readFreeMemoryBytes: () => 64 * GIB,
    startTunnel: async () => ({ stop: async () => { stopCount += 1; } }),
  });
  assert.equal(exitCode, 1);
  assert.equal(stopCount, 1);
  assert.ok(lineList.some((line) => line.startsWith('[factory] 시작 전 점검 실패: GPU 서비스에 닿지 못했다: VLM 127.0.0.1:9 연결이 끊김(ECONNRESET)')), lineList.join('\n'));
});

test('CLI: Bedrock 토큰이 없거나 ffmpeg 를 못 돌리면 종료 코드 1', async () => {
  const { lineList, log } = createLogCollector();
  const { AWS_BEARER_TOKEN_BEDROCK: _unused, ...envWithoutToken } = BASE_ENV;
  const exitCode = await runFactoryCli({
    argList: ['--input', makeInputDir(['a.mp4']), '--out', path.join(makeDir('no-token'), 'run')],
    env: { ...envWithoutToken, SEEON_FACTORY_FFMPEG: '/없는/ffmpeg' }, log, workerPath: FAKE_WORKER_PATH,
    checkService: async () => SERVICE_UP, runVersion: async (binaryPath) => { if (binaryPath.includes('없는')) throw new Error('ENOENT'); return Buffer.from('ok'); },
    checkTriggerAnalyzer: async () => [],
    readFreeMemoryBytes: () => 64 * GIB,
    startTunnel: PASSING_PREFLIGHT.startTunnel,
  });
  assert.equal(exitCode, 1);
  assert.ok(lineList.some((line) => line.includes('AWS_BEARER_TOKEN_BEDROCK 이 없다')), lineList.join('\n'));
  assert.ok(lineList.some((line) => line.includes('ffmpeg 를 실행하지 못했다(/없는/ffmpeg)')), lineList.join('\n'));
});

test('CLI: 처리할 영상이 없으면 종료 코드 1, 잘못된 인자는 Error', async () => {
  const { lineList, log } = createLogCollector();
  assert.equal(await runFactoryCli({ argList: ['--input', makeInputDir(['notes.txt'])], env: BASE_ENV, log, ...PASSING_PREFLIGHT }), 1);
  assert.ok(lineList.includes('[factory] 처리할 영상이 없다'));
  await assert.rejects(runFactoryCli({ argList: ['--input', 'x', '--language', 'jp'], env: BASE_ENV, log }), /ko·en·auto/);
});

test('CLI: 워커를 띄우기 전에 이전 완료 표시를 지워, --force 재실행이 도중에 죽으면 다음 실행이 다시 돈다', async () => {
  const inputDir = makeInputDir(['c-crash.mp4']);
  const outDir = path.join(makeDir('stale'), 'run');
  const pair = { outDir, outStem: 'c-crash', videoId: 'c-crash', filePath: path.join(inputDir, 'c-crash.mp4') };
  writeDonePair(pair);
  const runOnce = (extraArgList) => runFactoryCli({
    argList: ['--input', inputDir, '--out', outDir, ...extraArgList], env: BASE_ENV, log: createLogCollector().log, workerPath: FAKE_WORKER_PATH, ...PASSING_PREFLIGHT,
  });
  assert.equal(await runOnce([]), 0, '지금 작업과 같은 끝난 결과면 건너뛴다');
  assert.equal(fs.existsSync(path.join(outDir, 'c-crash.log')), false);
  assert.equal(await runOnce(['--force']), 1);
  assert.equal(fs.existsSync(path.join(outDir, 'c-crash_SEEON_AD.json')), false, '죽은 워커 뒤에 이전 완료 표시가 남지 않는다');
  assert.equal(fs.existsSync(path.join(outDir, 'c-crash_SEEON_AD.mp3')), false);
  assert.equal(await runOnce([]), 1);
  assert.equal(countStart({ outDir, outStem: 'c-crash' }), 2, '--force 없이 다시 돌려도 다시 돈다');
});

test('CLI: 같은 출력 폴더라도 언어·전환 고지 설정이 바뀐 영상은 다시 돈다', async () => {
  const inputDir = makeInputDir(['a.mp4']);
  const outDir = path.join(makeDir('config-change'), 'run');
  const runOnce = (extraArgList) => runFactoryCli({
    argList: ['--input', inputDir, '--out', outDir, ...extraArgList], env: BASE_ENV, log: createLogCollector().log, workerPath: FAKE_WORKER_PATH, ...PASSING_PREFLIGHT,
  });
  assert.equal(await runOnce(['--language', 'en']), 0);
  assert.equal(await runOnce(['--language', 'ko']), 0);
  assert.equal(countStart({ outDir, outStem: 'a' }), 2, '언어가 바뀌면 다시 돈다');
  assert.equal(await runOnce(['--language', 'ko']), 0);
  assert.equal(countStart({ outDir, outStem: 'a' }), 2, '같으면 건너뛴다');
  assert.equal(await runOnce(['--language', 'ko', '--include-page-transition']), 0);
  assert.equal(countStart({ outDir, outStem: 'a' }), 3, '전환 고지 설정이 바뀌면 다시 돈다');
});

test('CLI: --timeout-min 을 넘긴 영상은 워커를 멈추고 시간 초과로 기록한다', { timeout: 20000 }, async () => {
  const inputDir = makeInputDir(['x-hang.mp4', 'y.mp4']);
  const outDir = path.join(makeDir('timeout'), 'run');
  const exitCode = await runFactoryCli({
    argList: ['--input', inputDir, '--out', outDir, '--timeout-min', '0.005'], env: BASE_ENV, log: createLogCollector().log, workerPath: FAKE_WORKER_PATH, ...PASSING_PREFLIGHT,
  });
  assert.equal(exitCode, 1);
  const manifest = readJson(path.join(outDir, 'manifest.json'));
  assert.deepEqual(manifest.videoList.map((video) => [video.videoId, video.status]), [['x-hang', 'failed'], ['y', 'done']]);
  assert.match(manifest.videoList[0].errorMessage, /^시간 초과/);
  assert.match(fs.readFileSync(path.join(outDir, 'x-hang.log'), 'utf8'), /SIGTERM 받음/);
});

test('CLI: 영상 하나가 끝날 때마다 manifest·summary 를 고쳐 써 중간에 죽어도 기록이 남는다', { timeout: 20000 }, async () => {
  const inputDir = makeInputDir(['a.mp4', 'b-slow.mp4']);
  const outDir = path.join(makeDir('incremental'), 'run');
  let manifestAtFirstEnd = null;
  const { log } = createLogCollector({
    onLine: (line) => {
      if (!manifestAtFirstEnd && line.startsWith('[factory] ✔')) manifestAtFirstEnd = readJson(path.join(outDir, 'manifest.json'));
    },
  });
  assert.equal(await runFactoryCli({
    argList: ['--input', inputDir, '--out', outDir, '--concurrency', '2'], env: BASE_ENV, log, workerPath: FAKE_WORKER_PATH, ...PASSING_PREFLIGHT,
  }), 0);
  assert.deepEqual(manifestAtFirstEnd.videoList.map((video) => [video.videoId, video.status]), [['a', 'done'], ['b-slow', 'not_run']]);
  assert.equal(manifestAtFirstEnd.endedAt, null);
  const manifest = readJson(path.join(outDir, 'manifest.json'));
  assert.deepEqual(manifest.videoList.map((video) => video.status), ['done', 'done']);
  assert.ok(manifest.endedAt);
  assert.deepEqual(fs.readdirSync(outDir).filter((name) => name.endsWith('.tmp')), []);
});

test('CLI: SIGINT 를 받으면 돌던 워커를 멈추고 남은 영상은 띄우지 않으며 manifest 를 쓰고 130 으로 끝난다', { timeout: 20000 }, async () => {
  const inputDir = makeInputDir(['a-hang.mp4', 'b-hang.mp4', 'c.mp4']);
  const outDir = path.join(makeDir('signal'), 'run');
  const signalSource = new EventEmitter();
  let startCount = 0;
  const { lineList, log } = createLogCollector({
    onLine: (line) => {
      if (!line.startsWith('[factory] ▶')) return;
      startCount += 1;
      if (startCount === 2) setTimeout(() => signalSource.emit('SIGINT', 'SIGINT'), 150);
    },
  });
  const exitCode = await runFactoryCli({
    argList: ['--input', inputDir, '--out', outDir, '--concurrency', '2'], env: BASE_ENV, log, workerPath: FAKE_WORKER_PATH, signalSource, ...PASSING_PREFLIGHT,
  });
  assert.equal(exitCode, 130);
  const manifest = readJson(path.join(outDir, 'manifest.json'));
  assert.equal(manifest.interruptedBy, 'SIGINT');
  assert.deepEqual(manifest.videoList.map((video) => [video.videoId, video.status, video.errorMessage]), [
    ['a-hang', 'failed', '중단됨(SIGINT)'], ['b-hang', 'failed', '중단됨(SIGINT)'], ['c', 'not_run', undefined],
  ]);
  assert.ok(manifest.endedAt);
  assert.match(fs.readFileSync(path.join(outDir, 'summary.txt'), 'utf8'), /SIGINT 로 중단/);
  assert.equal(fs.existsSync(path.join(outDir, 'c.log')), false, '중단 뒤에는 새 워커를 띄우지 않는다');
  assert.ok(lineList.some((line) => line.startsWith('[factory] SIGINT 받음')), lineList.join('\n'));
  assert.deepEqual(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signalName) => signalSource.listenerCount(signalName)), [0, 0, 0], '실행이 끝나면 신호 처리기를 뗀다');
});

// 이미 끝난 프로세스의 pid(낡은 잠금 시험용).
function readDeadPid() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    child.once('exit', () => resolve(child.pid));
  });
}

test('CLI: 같은 출력 폴더에 이미 실행이 붙어 있으면 워커 없이 종료 코드 1, 끝난 실행은 잠금을 풀고, 죽은 실행의 잠금은 알린 뒤 가져간다', { timeout: 20000 }, async () => {
  const inputDir = makeInputDir(['a-slow.mp4']);
  const outDir = path.join(makeDir('lock'), 'run');
  const lockPath = path.join(outDir, '.factory.lock');
  const runOnce = ({ log, extraArgList = [] }) => runFactoryCli({
    argList: ['--input', inputDir, '--out', outDir, ...extraArgList], env: BASE_ENV, log, workerPath: FAKE_WORKER_PATH, ...PASSING_PREFLIGHT,
  });
  let secondRun = null;
  const first = createLogCollector({
    onLine: (line) => {
      if (secondRun || !line.startsWith('[factory] ▶')) return;
      const second = createLogCollector();
      secondRun = runOnce({ log: second.log }).then((exitCode) => ({ exitCode, lineList: second.lineList }));
    },
  });
  assert.equal(await runOnce({ log: first.log }), 0);
  const { exitCode, lineList } = await secondRun;
  assert.equal(exitCode, 1);
  assert.ok(lineList.some((line) => line.startsWith(`[factory] 이 출력 폴더는 이미 다른 실행(pid ${process.pid}`)), lineList.join('\n'));
  assert.equal(countStart({ outDir, outStem: 'a-slow' }), 1, '두 번째 실행은 워커를 띄우지 않는다');
  assert.equal(fs.existsSync(lockPath), false, '끝난 실행은 잠금을 푼다');

  const deadPid = await readDeadPid();
  fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, host: os.hostname(), startedAt: '2026-10-06T00:00:00.000Z' }));
  const takeOver = createLogCollector();
  assert.equal(await runOnce({ log: takeOver.log, extraArgList: ['--force'] }), 0);
  assert.ok(takeOver.lineList.some((line) => line.includes(`낡은 잠금(pid ${deadPid}`)), takeOver.lineList.join('\n'));
  assert.equal(countStart({ outDir, outStem: 'a-slow' }), 2);
  assert.equal(fs.existsSync(lockPath), false);
});

test('CLI: 다시 처리하는 영상은 이전 실행이 남긴 작업 폴더(AD wav·합성 조각)를 먼저 비우고, 건너뛴 영상의 작업 폴더는 그대로 둔다', async () => {
  const inputDir = makeInputDir(['a.mp4', 'b.mp4']);
  const outDir = path.join(makeDir('workdir'), 'run');
  const staleFileList = [WORK_DIR_MARKER_NAME, 'ad/ad-009.wav', 'render-3.wav', 'pipeline-1.jsonl'];
  for (const outStem of ['a', 'b']) {
    fs.mkdirSync(path.join(outDir, outStem, 'ad'), { recursive: true });
    for (const name of staleFileList) fs.writeFileSync(path.join(outDir, outStem, name), 'old');
  }
  writeDonePair({ outDir, outStem: 'b', videoId: 'b', filePath: path.join(inputDir, 'b.mp4') });
  assert.equal(await runFactoryCli({
    argList: ['--input', inputDir, '--out', outDir], env: BASE_ENV, log: createLogCollector().log, workerPath: FAKE_WORKER_PATH, ...PASSING_PREFLIGHT,
  }), 0);
  assert.equal(countStart({ outDir, outStem: 'a' }), 1);
  assert.equal(fs.existsSync(path.join(outDir, 'a')), false, '이전 실행의 작업 폴더를 비운다');
  for (const name of staleFileList) assert.ok(fs.existsSync(path.join(outDir, 'b', name)), `건너뛴 영상의 ${name} 은 결과가 가리키므로 남긴다`);
});

test('CLI: --out 을 영상 폴더와 같게 주고 영상과 같은 이름의 사용자 폴더가 있으면, 그 폴더는 지우지도 쓰지도 않고 그 영상만 실패로 둔다', async () => {
  const inputDir = makeInputDir(['lecture.mp4', 'b.mp4']);
  const userDir = path.join(inputDir, 'lecture');
  fs.mkdirSync(path.join(userDir, 'slides'), { recursive: true });
  fs.writeFileSync(path.join(userDir, 'slides', 'deck.pdf'), '사용자 자료');
  const { lineList, log } = createLogCollector();
  assert.equal(await runFactoryCli({
    argList: ['--input', inputDir, '--out', inputDir], env: BASE_ENV, log, workerPath: FAKE_WORKER_PATH, ...PASSING_PREFLIGHT,
  }), 1);
  assert.equal(fs.readFileSync(path.join(userDir, 'slides', 'deck.pdf'), 'utf8'), '사용자 자료');
  assert.deepEqual(fs.readdirSync(userDir), ['slides'], '사용자 폴더에 표식도 쓰지 않는다');
  assert.equal(fs.existsSync(path.join(inputDir, 'lecture.log')), false, '그 영상의 워커는 띄우지 않는다');
  const videoById = Object.fromEntries(readJson(path.join(inputDir, 'manifest.json')).videoList.map((video) => [video.videoId, video]));
  assert.equal(videoById.lecture.status, 'failed');
  assert.match(videoById.lecture.errorMessage, /공장 표식\(\.seeon-factory-work\)이 없는 폴더가 있어 지우지도 쓰지도 않는다/);
  assert.equal(videoById.b.status, 'done', '다른 영상은 그대로 처리한다');
  assert.ok(lineList.some((line) => line.startsWith('[factory] ✖') && line.includes('lecture')), lineList.join('\n'));
});

test('CLI: 끝난 결과라도 seeon-meet·공장 버전이나 결과 설정(모델)이 지금과 다르면 이유를 한 줄 찍고 다시 만들고, 주소만 바뀐 것은 건너뛴다', { timeout: 20000 }, async () => {
  const inputDir = makeInputDir(['a.mp4', 'b.mp4']);
  const outDir = path.join(makeDir('identity'), 'run');
  const runOnce = async (env = BASE_ENV) => {
    const { lineList, log } = createLogCollector();
    assert.equal(await runFactoryCli({ argList: ['--input', inputDir, '--out', outDir], env, log, workerPath: FAKE_WORKER_PATH, ...PASSING_PREFLIGHT }), 0);
    return lineList.filter((line) => line.startsWith('[factory] ↻'));
  };
  const countStartPair = () => [countStart({ outDir, outStem: 'a' }), countStart({ outDir, outStem: 'b' })];
  assert.deepEqual(await runOnce(), []);
  const manifest = readJson(path.join(outDir, 'manifest.json'));
  assert.match(manifest.factory.commit, /^[0-9a-f]{40}$/);
  assert.equal(typeof manifest.factory.isDirty, 'boolean');
  assert.equal(manifest.resultConfig.vlmModel, 'qwen3.5-35b-a3b');
  assert.equal(manifest.runOptions.concurrency, 1);
  assert.match(fs.readFileSync(path.join(outDir, 'summary.txt'), 'utf8'), new RegExp(`공장 ${manifest.factory.commit.slice(0, 7)}`));
  const aReport = readJson(path.join(outDir, 'a_SEEON_AD.json'));
  assert.deepEqual([aReport.factory, aReport.config.runConcurrency], [manifest.factory, 1], '결과 JSON 에 공장 버전·동시 수를 남긴다');
  assert.deepEqual(await runOnce(), [], '같은 코드·설정이면 건너뛴다');
  assert.deepEqual(countStartPair(), [1, 1]);

  fs.writeFileSync(path.join(outDir, 'a_SEEON_AD.json'), JSON.stringify({ ...aReport, seeonMeet: { ...aReport.seeonMeet, commit: '0'.repeat(40) } }));
  assert.deepEqual(await runOnce(), [`[factory] ↻ a 이전 완료 결과와 달라 다시 만든다 — seeon-meet 커밋 0000000 → ${manifest.seeonMeet.commit.slice(0, 7)}`]);
  assert.deepEqual(countStartPair(), [2, 1]);

  const modelEnv = { ...BASE_ENV, SEEON_VLM_MODEL: 'other-vlm' };
  // 판정 LLM 은 VLM 과 따로 띄운 모델(제품 기본 qwen3.5-9b)이라 VLM 모델만 다르다.
  assert.deepEqual(await runOnce(modelEnv), ['a', 'b'].map((videoId) => `[factory] ↻ ${videoId} 이전 완료 결과와 달라 다시 만든다 — `
    + '결과 설정 vlmModel qwen3.5-35b-a3b → other-vlm'));
  assert.deepEqual(countStartPair(), [3, 2]);
  assert.deepEqual(await runOnce({ ...modelEnv, SEEON_ASR_URL: 'http://127.0.0.1:10/asr' }), [], '서비스 주소(터널·직접 연결)는 결과 설정이 아니다');
  assert.deepEqual(countStartPair(), [3, 2]);
});

test('CLI: 경고(부하로 생긴 시간 초과 등)가 있는 영상은 완료로 치되 터미널·summary 에 ⚠ 와 수를 찍고 manifest 에 남기며, 다시 돌지 않는다', async () => {
  const inputDir = makeInputDir(['a-warn.mp4', 'b.mp4']);
  const outDir = path.join(makeDir('warning'), 'run');
  const runOnce = (log) => runFactoryCli({ argList: ['--input', inputDir, '--out', outDir], env: BASE_ENV, log, workerPath: FAKE_WORKER_PATH, ...PASSING_PREFLIGHT });
  const { lineList, log } = createLogCollector();
  assert.equal(await runOnce(log), 0, '경고는 실패가 아니다');
  assert.ok(lineList.some((line) => /^\[factory\] ✔ \[\d\/2\] a-warn AD 2개 · 1초 ⚠ vlm_timeout 4$/.test(line)), lineList.join('\n'));
  assert.ok(lineList.some((line) => /^\[factory\] ✔ \[\d\/2\] b AD 2개 · 1초$/.test(line)), lineList.join('\n'));
  const manifest = readJson(path.join(outDir, 'manifest.json'));
  assert.deepEqual(manifest.videoList.map((video) => video.warningList), [[{ code: 'vlm_timeout', count: 4, message: 'VLM 호출 시간 초과 4/16건' }], []]);
  const summary = fs.readFileSync(path.join(outDir, 'summary.txt'), 'utf8');
  assert.match(summary, /영상 2 · 완료 2\(경고 1\) · 실패 0 · 건너뜀 0/);
  assert.match(summary, /\n {2}✔ a-warn: AD 2개 ⚠ vlm_timeout 4\n/);
  assert.match(summary, /\n {2}✔ b: AD 2개\n/);
  assert.equal(await runOnce(createLogCollector().log), 0);
  assert.equal(countStart({ outDir, outStem: 'a-warn' }), 1);
});
