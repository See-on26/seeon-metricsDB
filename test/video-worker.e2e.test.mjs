import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fork, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockServices } from './helpers/mock-services.mjs';
import { createTestClip } from './helpers/media-fixtures.mjs';
import { waitRealUntil } from './helpers/real-wait.mjs';
import { resolveFfmpegPaths } from '../src/media/ffmpeg.mjs';
import { inspectVideoResult } from '../src/runner/manifest.mjs';
import { readResultIdentity } from '../src/runner/result-identity.mjs';
import { loadPipelineConfig } from '../src/product/product-loader.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const { ffprobePath } = resolveFfmpegPaths({ env: process.env });
const WORKER_PATH = fileURLToPath(new URL('../src/runner/video-worker.mjs', import.meta.url));
const mock = await startMockServices();
after(() => mock.close());

const WORKER_ENV = { PATH: process.env.PATH, HOME: process.env.HOME, ...mock.urlEnv };
const RUN_CONCURRENCY = 2;

// Bedrock 토큰 없이 돌린다: 탐지 판정(라우터·무발화·지시)은 mock 판정 LLM 주소의 GPU 판정, 틈 추론은 규칙 폴백(제품 동작). 실서비스 포트는 쓰지 않는다.
function runWorker({ job, outDir, extraEnv = {} }) {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER_PATH, [], {
      execArgv: ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'],
      env: { ...WORKER_ENV, ...extraEnv },
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
    child.send({ type: 'run', job, outDir, runConcurrency: RUN_CONCURRENCY });
  });
}

const readMp3Ms = (filePath) => Number(execFileSync(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath]).toString()) * 1000;

test('합성 발표 영상 하나를 워커로 끝까지 돌리면 mp3·json 이 나오고 길이 공식이 맞는다', { timeout: 180000 }, async () => {
  const dirPath = makeTempDir('factory-e2e-');
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
  // 발화 트리거(Kiwi 후보 → 판단 LLM O)에서 나온 해설이 들린다. 후보 유형에 따라 지시 또는 해석 해설이다.
  assert.ok(report.adList.some((ad) => ['deixis', 'interpretation'].includes(ad.type)), JSON.stringify({ adList: report.adList.map((ad) => ad.type), droppedList: report.droppedList }));
  for (const ad of report.adList) assert.ok(fs.existsSync(path.join(outDir, ad.wavFile)));
  const mp3Ms = readMp3Ms(path.join(outDir, 'deck_SEEON_AD.mp3'));
  assert.ok(Math.abs(mp3Ms - report.output.timelineDurationMs) < 150, `mp3 ${mp3Ms} / 타임라인 ${report.output.timelineDurationMs}`);
  const expectedMs = report.output.sourceMediaMs + report.output.adTotalMs + report.output.silenceTotalMs - report.output.recoveredMs;
  assert.ok(Math.abs(mp3Ms - expectedMs) <= 1000);
  assert.ok(Math.abs(report.output.sourceMediaMs - 24000) < 100, '원음을 끝까지 다 틀었다');
  assert.ok(report.stats.serviceMap.asr.count >= 3);
  // 판정 요청은 VLM 과 따로 띄운 판정 LLM 주소로 간다. mock 이 받은 수와 기록이 같아야 한다.
  const { serviceMap, judgeSourceCountMap } = report.stats;
  assert.ok(serviceMap.judge.count >= 1, JSON.stringify(serviceMap));
  assert.equal(serviceMap.judge.count, countAfter.judge - countBefore.judge);
  assert.equal(serviceMap.vlm.count, countAfter.vlm - countBefore.vlm);
  const judgeGpuCount = Object.values(judgeSourceCountMap).reduce((sum, countMap) => sum + countMap.gpu, 0);
  assert.equal(judgeGpuCount, serviceMap.judge.count, JSON.stringify(judgeSourceCountMap));
  assert.ok(judgeSourceCountMap.router.gpu >= 1, '지시 해설은 통합 라우터 GPU 판정을 거친다');
  assert.ok(Object.values(judgeSourceCountMap).every((countMap) => countMap.bedrock === 0 && countMap.error === 0));
  const { modelConfig } = report.config;
  assert.deepEqual([modelConfig.judgeBackend, modelConfig.judgeGpuUrl, modelConfig.judgeGpuModel], ['gpu', mock.urlEnv.SEEON_JUDGE_GPU_URL, 'qwen3.5-9b']);
  assert.equal(modelConfig.isScaleEnabled, true, '척도 해설은 제품 기본으로 켠다');
  // 캡션에는 소리가 없고 렌더러가 pipeline-tts 로 합성한다. 재생된 AD 는 모두 합성한 소리다.
  const { tts } = report.stats;
  assert.equal(tts.requestCount, tts.okCount + tts.failCount + tts.pendingAtStopCount);
  assert.ok(serviceMap.tts.count >= tts.okCount + tts.failCount && serviceMap.tts.count <= tts.requestCount, JSON.stringify({ tts, serviceTts: serviceMap.tts }));
  assert.ok(report.stats.tts.okCount >= report.adList.length);
  assert.ok(report.adList.every((ad) => ad.tts && ad.serviceCallList.some((call) => call.service === 'tts')));
  assert.ok(report.stats.triggerAnalyzerCountMap.kiwi >= 1, JSON.stringify(report.stats.triggerAnalyzerCountMap));
  assert.equal(report.stats.triggerAnalyzerCountMap.rule, undefined, '세션 전에 Kiwi 준비를 기다려 대체 규칙을 쓰지 않는다');
  assert.ok(modelConfig.judgeModelId, 'GPU 가 실패하면 넘어갈 Bedrock 판정 모델');
  // 슬라이드 전사는 기본 VLM 이다. 제품 기록에서 센 출처가 VLM 이고 OCR 호출은 없다.
  assert.deepEqual([report.config.resultConfig.slideTextBackend, report.config.resultConfig.gapSource], ['vlm', 'asr']);
  assert.ok(report.stats.slideText.count >= 1, JSON.stringify(report.stats.slideText));
  assert.deepEqual(report.stats.slideText.sourceCountMap, { ocr: 0, vlm: report.stats.slideText.count });
  assert.equal(serviceMap.ocr, undefined);
  assert.equal(countAfter.ocr, countBefore.ocr);
  assert.deepEqual(result.slideText, report.stats.slideText, '워커 결과(summary 용)에도 싣는다');
  assert.equal(result.serviceCountMap.vlm, serviceMap.vlm.count);
  assert.ok(fs.readdirSync(path.join(outDir, 'deck')).some((name) => /^pipeline-\d+\.jsonl$/.test(name)));
  assert.ok(report.droppedList.filter((drop) => drop.type === 'page_transition').every((drop) => drop.reason === 'feature_off'), '평가 프리셋: 전환 고지는 생성만');
  assert.deepEqual(report.stats.swallowedErrorCountMap, { task: {}, ipc: {} }, '실제 제품 응답에서 연결 코드가 삼킨 오류가 없다');
  assert.deepEqual([report.incompleteReasonList, report.warningList], [[], []], '건강한 서비스면 불완전 사유도 경고도 없다');
  assert.match(report.factory.commit, /^[0-9a-f]{40}$/);
  assert.equal(report.config.runConcurrency, RUN_CONCURRENCY);
  const identity = readResultIdentity({ pipelineConfig: loadPipelineConfig().readPipelineConfig(WORKER_ENV) });
  assert.deepEqual(
    inspectVideoResult({ outDir, outStem: 'deck', videoId: 'deck', filePath, language: 'ko', isPageTransitionIncluded: false, identity }),
    { status: 'done', mismatchList: [] }, '실제 워커가 남긴 코드 버전·결과 설정을 CLI 가 지금과 같은 것으로 본다',
  );
});

test('슬라이드 전사 백엔드 ocr: /ocr 호출을 임베딩이 아닌 ocr 로 세고, 전사 출처를 ocr 로 남기며, 백엔드를 바꾸면 다시 만든다', { timeout: 180000 }, async () => {
  const dirPath = makeTempDir('factory-e2e-ocr-');
  const filePath = await createTestClip({
    dirPath, fileName: 'deck.mp4', width: 640, height: 360,
    colorTimeline: [['0x3050a0', 12], ['0xa05030', 12]], audioExpr: '0.4*sin(2*PI*220*t)*lt(mod(t,8),6)',
  });
  const outDir = path.join(dirPath, 'out');
  const countBefore = { ...mock.state.callCountMap };
  const extraEnv = { SEEON_SLIDE_TEXT_BACKEND: 'ocr' };
  const result = await runWorker({ job: { videoId: 'deck', filePath, outStem: 'deck', language: 'ko', isPageTransitionIncluded: false }, outDir, extraEnv });
  assert.equal(result.status, 'done', result.logText.slice(-2000));
  const report = JSON.parse(fs.readFileSync(path.join(outDir, 'deck_SEEON_AD.json'), 'utf8'));
  assert.equal(report.isComplete, true);
  assert.equal(report.config.resultConfig.slideTextBackend, 'ocr');
  assert.equal(report.config.modelConfig.ocrUrl, mock.urlEnv.SEEON_EMBED_URL.replace(/\/embed$/, '/ocr'));
  const { serviceMap, slideText } = report.stats;
  const ocrCallCount = mock.state.callCountMap.ocr - countBefore.ocr;
  assert.ok(ocrCallCount >= 1);
  assert.equal(serviceMap.ocr.count, ocrCallCount, 'OCR 호출은 임베딩이 아니라 ocr 로 센다');
  assert.equal(serviceMap.embed.count, mock.state.callCountMap.embed - countBefore.embed);
  assert.equal(slideText.count, ocrCallCount, JSON.stringify(slideText));
  assert.deepEqual(slideText.sourceCountMap, { ocr: slideText.count, vlm: 0 });
  assert.deepEqual(slideText.fallbackReasonCountMap, { low_score: 0, vertical_text: 0, ocr_error: 0, ocr_bypass: 0 });
  assert.deepEqual(report.warningList, []);
  assert.equal(result.serviceCountMap.ocr, ocrCallCount);
  const inspectWith = (env) => inspectVideoResult({
    outDir, outStem: 'deck', videoId: 'deck', filePath, language: 'ko', isPageTransitionIncluded: false,
    identity: readResultIdentity({ pipelineConfig: loadPipelineConfig().readPipelineConfig(env) }),
  });
  assert.equal(inspectWith({ ...WORKER_ENV, ...extraEnv }).status, 'done');
  assert.deepEqual(inspectWith(WORKER_ENV), { status: 'mismatch', mismatchList: ['결과 설정 slideTextBackend ocr → vlm'] }, '백엔드를 바꿔 같은 --out 으로 돌리면 다시 만든다');
});

test('슬라이드 전사 백엔드 ocr: OCR 평균 점수가 낮은 장은 제품이 VLM 으로 다시 전사하고, 출처 vlm·이유 low_score 로 남는다', { timeout: 180000 }, async () => {
  const dirPath = makeTempDir('factory-e2e-ocr-low-');
  const filePath = await createTestClip({
    dirPath, fileName: 'deck.mp4', width: 640, height: 360,
    colorTimeline: [['0x3050a0', 12], ['0xa05030', 12]], audioExpr: '0.4*sin(2*PI*220*t)*lt(mod(t,8),6)',
  });
  const outDir = path.join(dirPath, 'out');
  mock.setOcrMeanScoreList([0.4]);
  try {
    const result = await runWorker({
      job: { videoId: 'deck', filePath, outStem: 'deck', language: 'ko', isPageTransitionIncluded: false }, outDir, extraEnv: { SEEON_SLIDE_TEXT_BACKEND: 'ocr' },
    });
    assert.equal(result.status, 'done', result.logText.slice(-2000));
    const { slideText, serviceMap } = JSON.parse(fs.readFileSync(path.join(outDir, 'deck_SEEON_AD.json'), 'utf8')).stats;
    assert.ok(slideText.count >= 1);
    assert.equal(serviceMap.ocr.count, slideText.count);
    assert.deepEqual(slideText.sourceCountMap, { ocr: 0, vlm: slideText.count });
    assert.deepEqual(slideText.fallbackReasonCountMap, { low_score: slideText.count, vertical_text: 0, ocr_error: 0, ocr_bypass: 0 });
  } finally {
    mock.setOcrMeanScoreList([0.95]);
  }
});

test('오디오 트랙 없는 영상도 끝까지 돌고 AD 0개로 끝난다', { timeout: 120000 }, async () => {
  const dirPath = makeTempDir('factory-e2e-silent-');
  const filePath = await createTestClip({ dirPath, fileName: 'mute.mp4', colorTimeline: [['gray', 6]], hasAudio: false });
  const outDir = path.join(dirPath, 'out');
  const result = await runWorker({ job: { videoId: 'mute', filePath, outStem: 'mute', language: 'auto', isPageTransitionIncluded: false }, outDir });
  assert.equal(result.status, 'done', result.logText.slice(-2000));
  const report = JSON.parse(fs.readFileSync(path.join(outDir, 'mute_SEEON_AD.json'), 'utf8'));
  assert.equal(report.adList.length, 0);
  assert.deepEqual(report.stats.swallowedErrorCountMap, { task: {}, ipc: {} });
  assert.ok(Math.abs(report.output.sourceMediaMs - 6000) < 100);
  assert.ok(Math.abs(readMp3Ms(path.join(outDir, 'mute_SEEON_AD.mp3')) - report.output.timelineDurationMs) < 150);
});

function listProcessByArg(text) {
  return execFileSync('ps', ['-ax', '-o', 'pid=,command=']).toString().split('\n').filter((line) => line.includes(text) && !line.includes(' ps '));
}

test('워커는 SIGTERM 을 받으면 띄운 ffmpeg·ffprobe 를 죽이고 143 으로 끝난다', { timeout: 60000 }, async () => {
  const dirPath = makeTempDir('factory-e2e-sigterm-');
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
async function startStuckWorker({ name }) {
  const dirPath = makeTempDir(`factory-e2e-${name}-`);
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

test('워커는 터미널 Ctrl-C 의 SIGINT 로 죽지 않고, 부모가 보낸 SIGTERM 에 정리하고 끝난다', { timeout: 60000 }, async () => {
  const { child, fifoPath, exitPromise } = await startStuckWorker({ name: 'sigint' });
  let exitState = null;
  exitPromise.then((state) => { exitState = state; });
  child.kill('SIGINT');
  assert.equal(await waitRealUntil(() => exitState !== null, { limitMs: 500, pollMs: 20 }), false, `SIGINT 에 끝나면 안 된다: ${JSON.stringify(exitState)}`);
  child.kill('SIGTERM');
  assert.deepEqual(await exitPromise, { code: 143, signal: null });
  assert.ok(await waitRealUntil(() => listProcessByArg(fifoPath).length === 0, { limitMs: 3000, pollMs: 50 }), `남은 자식: ${listProcessByArg(fifoPath).join(' | ')}`);
});

test('워커는 부모와 IPC 가 끊기면(부모가 죽음) 띄운 ffprobe 를 죽이고 스스로 끝난다', { timeout: 60000 }, async () => {
  const { child, fifoPath, exitPromise } = await startStuckWorker({ name: 'disconnect' });
  child.disconnect();
  assert.deepEqual(await exitPromise, { code: 1, signal: null });
  assert.ok(await waitRealUntil(() => listProcessByArg(fifoPath).length === 0, { limitMs: 3000, pollMs: 50 }), `남은 자식: ${listProcessByArg(fifoPath).join(' | ')}`);
});

test('ASR 이 계속 실패하면(서비스 장애) 결과를 불완전으로 남기고 워커는 실패로 끝나, 다시 돌리면 그 영상을 다시 처리한다', { timeout: 120000 }, async (t) => {
  const dirPath = makeTempDir('factory-e2e-asr-down-');
  const filePath = await createTestClip({ dirPath, fileName: 'talk.mp4', colorTimeline: [['gray', 10]], audioExpr: '0.4*sin(2*PI*220*t)*lt(mod(t,5),4)' });
  const outDir = path.join(dirPath, 'out');
  mock.setAsrStatus(500);
  t.after(() => mock.setAsrStatus(200));
  const result = await runWorker({ job: { videoId: 'talk', filePath, outStem: 'talk', language: 'ko', isPageTransitionIncluded: false }, outDir });
  assert.equal(result.status, 'failed', result.logText.slice(-2000));
  assert.match(result.message, /^결과가 불완전하다 — ASR 실패 (\d+)\/\1건\(100% > 10%\) — HTTP 500/);
  const report = JSON.parse(fs.readFileSync(path.join(outDir, 'talk_SEEON_AD.json'), 'utf8'));
  assert.equal(report.isComplete, false);
  assert.deepEqual(report.incompleteReasonList.map((reason) => reason.code), ['asr_failure']);
  assert.equal(inspectVideoResult({ outDir, outStem: 'talk' }).status, 'incomplete', '다시 돌리면 다시 처리한다');
});

test('TTS 가 죽어 해설이 모두 소리를 잃으면 AD 없는 결과를 완료로 두지 않고 불완전으로 남겨, 다시 돌리면 그 영상을 다시 처리한다', { timeout: 180000 }, async (t) => {
  const dirPath = makeTempDir('factory-e2e-tts-down-');
  const filePath = await createTestClip({
    dirPath, fileName: 'deck.mp4', width: 640, height: 360,
    colorTimeline: [['0x3050a0', 12], ['0xa05030', 12]], audioExpr: '0.4*sin(2*PI*220*t)*lt(mod(t,8),6)',
  });
  const outDir = path.join(dirPath, 'out');
  mock.setTtsStatus(500);
  t.after(() => mock.setTtsStatus(200));
  const result = await runWorker({ job: { videoId: 'deck', filePath, outStem: 'deck', language: 'ko', isPageTransitionIncluded: false }, outDir });
  assert.equal(result.status, 'failed', result.logText.slice(-2000));
  assert.match(result.message, /^결과가 불완전하다 — TTS 장애 — 해설 \d+개 중 소리를 만든 해설 없음\(TTS 실패 (\d+)\/\1건\) — HTTP 500/);
  const report = JSON.parse(fs.readFileSync(path.join(outDir, 'deck_SEEON_AD.json'), 'utf8'));
  assert.equal(report.isComplete, false);
  assert.equal(report.adList.length, 0);
  assert.ok(report.droppedList.some((drop) => drop.reason === 'tts_failed'), JSON.stringify(report.droppedList));
  assert.deepEqual(report.incompleteReasonList.map((reason) => reason.code), ['tts_unavailable']);
  assert.equal(report.warningList.some((warning) => warning.code.startsWith('tts_')), false, '불완전 사유로 센 TTS 실패는 경고로 다시 세지 않는다');
  assert.equal(inspectVideoResult({ outDir, outStem: 'deck' }).status, 'incomplete', '다시 돌리면 다시 처리한다');
});

test('워커는 작업 폴더 자리에 공장이 만들지 않은 같은 이름의 폴더가 있으면 그 안에 쓰지 않고 실패로 끝난다', { timeout: 60000 }, async () => {
  const dirPath = makeTempDir('factory-e2e-user-folder-');
  const filePath = await createTestClip({ dirPath, fileName: 'lecture.mp4', colorTimeline: [['gray', 2]], hasAudio: false });
  const userDir = path.join(dirPath, 'lecture');
  fs.mkdirSync(userDir);
  fs.writeFileSync(path.join(userDir, 'notes.txt'), '사용자 자료');
  const result = await runWorker({ job: { videoId: 'lecture', filePath, outStem: 'lecture', language: 'ko', isPageTransitionIncluded: false }, outDir: dirPath });
  assert.equal(result.status, 'failed', result.logText.slice(-2000));
  assert.match(result.message, /공장 표식\(\.seeon-factory-work\)이 없는 폴더가 있어 지우지도 쓰지도 않는다/);
  assert.deepEqual(fs.readdirSync(userDir), ['notes.txt']);
  assert.equal(fs.existsSync(path.join(dirPath, 'lecture_SEEON_AD.mp3')), false);
});

// 워커 환경만 바꾼다. 같은 mock 서버를 가리키되 주소에 사용자 정보를 넣어 undici 가 요청을 만들 때 거부하게 한다.
function runWorkerWithEnv({ job, outDir, env }) {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER_PATH, [], { execArgv: ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let result = null;
    let logText = '';
    child.stdout.on('data', (chunk) => { logText += chunk; });
    child.stderr.on('data', (chunk) => { logText += chunk; });
    child.on('message', (message) => {
      if (message.type === 'failed') result = { status: 'failed', message: message.message };
      if (message.type === 'done') result = message.result;
    });
    child.on('exit', (code) => (result ? resolve({ ...result, logText, code }) : reject(new Error(`워커가 결과 없이 끝남(${code}): ${logText.slice(-1500)}`))));
    child.send({ type: 'run', job, outDir, runConcurrency: 1 });
  });
}

test('TTS 주소에 비밀번호가 들어 있으면 결과 JSON·실패 문구·워커 로그(제품 콘솔 포함)에는 비밀번호를 지운 주소만 남는다', { timeout: 180000 }, async () => {
  const dirPath = makeTempDir('factory-e2e-credential-');
  const filePath = await createTestClip({
    dirPath, fileName: 'deck.mp4', width: 640, height: 360,
    colorTimeline: [['0x3050a0', 12], ['0xa05030', 12]], audioExpr: '0.4*sin(2*PI*220*t)*lt(mod(t,8),6)',
  });
  const outDir = path.join(dirPath, 'out');
  const ttsUrl = new URL(mock.urlEnv.SEEON_TTS_URL);
  ttsUrl.username = 'user';
  ttsUrl.password = 'secretpw';
  const result = await runWorkerWithEnv({
    job: { videoId: 'deck', filePath, outStem: 'deck', language: 'ko', isPageTransitionIncluded: false }, outDir,
    env: { ...WORKER_ENV, SEEON_TTS_URL: ttsUrl.href },
  });
  assert.equal(result.status, 'failed', result.logText.slice(-2000));
  assert.match(result.message, /TTS 장애/);
  const reportText = fs.readFileSync(path.join(outDir, 'deck_SEEON_AD.json'), 'utf8');
  assert.match(JSON.parse(reportText).incompleteReasonList[0].message, /credentials: http:\/\/127\.0\.0\.1:\d+\/tts/);
  assert.match(result.logText, /TTS 실패\(소리 없이 넘어감\)/, '제품 콘솔 줄도 워커 로그로 간다');
  for (const [name, text] of [['JSON', reportText], ['실패 문구', result.message], ['워커 로그', result.logText]]) {
    assert.equal(text.includes('secretpw'), false, `${name} 에 비밀번호가 남았다`);
  }
});
