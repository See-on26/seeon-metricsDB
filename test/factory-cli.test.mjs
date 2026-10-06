import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFactoryCli } from '../src/cli/factory-cli.mjs';

const FAKE_WORKER_PATH = fileURLToPath(new URL('./helpers/fake-video-worker.mjs', import.meta.url));
// GPU 실서비스 포트(8801–8804)에 닿지 않게 모든 주소를 쓰지 않는 포트로 두고, 포트 점검은 대역으로 바꾼다.
const BASE_ENV = {
  PATH: process.env.PATH, HOME: process.env.HOME, AWS_BEARER_TOKEN_BEDROCK: 'test-token',
  SEEON_VLM_URL: 'http://127.0.0.1:9/v1/chat/completions', SEEON_ASR_URL: 'http://127.0.0.1:9/asr',
  SEEON_TTS_URL: 'http://127.0.0.1:9/tts', SEEON_TTS_LONG_URL: 'http://127.0.0.1:9/tts-long', SEEON_EMBED_URL: 'http://127.0.0.1:9/embed',
};
const PASSING_PREFLIGHT = {
  checkPort: async () => true,
  runVersion: async () => Buffer.from('ok'),
  startTunnel: async () => assert.fail('포트가 열려 있으면 터널을 열지 않는다'),
};

const makeDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `factory-cli-${name}-`));

function makeInputDir(nameList) {
  const dirPath = makeDir('input');
  for (const name of nameList) fs.writeFileSync(path.join(dirPath, name), '');
  return dirPath;
}

function createLogCollector() {
  const lineList = [];
  const push = (...partList) => lineList.push(partList.join(' '));
  return { lineList, log: { log: push, error: push, warn: push } };
}

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const countStart = ({ outDir, outStem }) => (fs.readFileSync(path.join(outDir, `${outStem}.log`), 'utf8').match(/\[fake-worker\] .* 시작/g) || []).length;

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
    argList: ['--input', inputDir, '--out', outDir, '--language', 'en'], env: BASE_ENV, log: rerun.log, workerPath: FAKE_WORKER_PATH, ...PASSING_PREFLIGHT,
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

test('CLI: GPU 포트가 닫혀 있고 터널도 못 열면 이유를 찍고 워커 없이 종료 코드 1', async () => {
  const inputDir = makeInputDir(['a.mp4']);
  const outDir = path.join(makeDir('closed'), 'run');
  const { lineList, log } = createLogCollector();
  let tunnelCallCount = 0;
  const exitCode = await runFactoryCli({
    argList: ['--input', inputDir, '--out', outDir], env: BASE_ENV, log, workerPath: FAKE_WORKER_PATH,
    checkPort: async ({ host, port }) => !(host === '127.0.0.1' && port === 9),
    runVersion: async () => Buffer.from('ok'),
    startTunnel: async () => { tunnelCallCount += 1; return null; },
  });
  assert.equal(exitCode, 1);
  assert.equal(tunnelCallCount, 1);
  assert.ok(lineList.some((line) => line.startsWith('[factory] GPU 포트 닫힘(VLM 127.0.0.1:9, ASR 127.0.0.1:9, TTS 127.0.0.1:9, EMBED 127.0.0.1:9)')), lineList.join('\n'));
  assert.ok(lineList.some((line) => line.startsWith('[factory] 시작 전 점검 실패: GPU 서비스에 닿지 못했다: VLM 127.0.0.1:9')), lineList.join('\n'));
  assert.equal(fs.existsSync(outDir), false, '점검에 실패하면 출력 폴더를 만들지 않는다');
});

test('CLI: 터널이 열리다 실패하면 그 이유도 점검 실패로 찍는다', async () => {
  const { lineList, log } = createLogCollector();
  const exitCode = await runFactoryCli({
    argList: ['--input', makeInputDir(['a.mp4']), '--out', path.join(makeDir('tunnel-error'), 'run')], env: BASE_ENV, log, workerPath: FAKE_WORKER_PATH,
    checkPort: async () => false, runVersion: async () => Buffer.from('ok'),
    startTunnel: async () => { throw new Error('GPU 터널이 제때 연결되지 않았다'); },
  });
  assert.equal(exitCode, 1);
  assert.ok(lineList.includes('[factory] 시작 전 점검 실패: GPU 터널이 제때 연결되지 않았다'), lineList.join('\n'));
});

test('CLI: 닫힌 포트를 제품 터널로 열면 다시 점검해 돌리고, 끝나면 터널을 닫는다', async () => {
  const inputDir = makeInputDir(['a.mp4']);
  const outDir = path.join(makeDir('tunnel'), 'run');
  let isTunnelOpen = false;
  let stopCount = 0;
  let tunnelEnv = null;
  const exitCode = await runFactoryCli({
    argList: ['--input', inputDir, '--out', outDir], env: { ...BASE_ENV, SEEON_GPU_SSH_KEY: '/keys/app' }, log: createLogCollector().log, workerPath: FAKE_WORKER_PATH,
    checkPort: async () => isTunnelOpen, runVersion: async () => Buffer.from('ok'),
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

test('CLI: 터널이 열렸는데도 포트가 닫혀 있으면(원격 주소 등) 점검 실패로 터널을 닫고 종료 코드 1', async () => {
  let stopCount = 0;
  const { lineList, log } = createLogCollector();
  const exitCode = await runFactoryCli({
    argList: ['--input', makeInputDir(['a.mp4']), '--out', path.join(makeDir('tunnel-still-closed'), 'run')], env: BASE_ENV, log, workerPath: FAKE_WORKER_PATH,
    checkPort: async ({ port }) => port !== 9, runVersion: async () => Buffer.from('ok'),
    startTunnel: async () => ({ stop: async () => { stopCount += 1; } }),
  });
  assert.equal(exitCode, 1);
  assert.equal(stopCount, 1);
  assert.ok(lineList.some((line) => line.startsWith('[factory] 시작 전 점검 실패: GPU 서비스에 닿지 못했다: VLM 127.0.0.1:9')), lineList.join('\n'));
});

test('CLI: Bedrock 토큰이 없거나 ffmpeg 를 못 돌리면 종료 코드 1', async () => {
  const { lineList, log } = createLogCollector();
  const { AWS_BEARER_TOKEN_BEDROCK: _unused, ...envWithoutToken } = BASE_ENV;
  const exitCode = await runFactoryCli({
    argList: ['--input', makeInputDir(['a.mp4']), '--out', path.join(makeDir('no-token'), 'run')],
    env: { ...envWithoutToken, SEEON_FACTORY_FFMPEG: '/없는/ffmpeg' }, log, workerPath: FAKE_WORKER_PATH,
    checkPort: async () => true, runVersion: async (binaryPath) => { if (binaryPath.includes('없는')) throw new Error('ENOENT'); return Buffer.from('ok'); },
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
