import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createVirtualClock } from '../src/clock/virtual-clock.mjs';
import { createSessionSimulator } from '../src/session/session-simulator.mjs';
import { summarizeTimeline } from '../src/session/playback-recorder.mjs';
import { openSampleFrameReader } from '../src/media/frame-source.mjs';
import { probeVideo } from '../src/media/probe.mjs';
import { resolveFfmpegPaths } from '../src/media/ffmpeg.mjs';
import { createFakeBridge } from './helpers/session-fakes.mjs';
import { createTestClip } from './helpers/media-fixtures.mjs';
import { createToneWav } from './helpers/mock-services.mjs';
import { renderOutputMp3 } from '../src/output/render-mp3.mjs';
import { runBinary } from '../src/media/ffmpeg.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const { ffmpegPath, ffprobePath } = resolveFfmpegPaths({ env: process.env });
const dirPath = makeTempDir('factory-simulator-');
const stillClipPath = await createTestClip({ dirPath, fileName: 'still.mp4', colorTimeline: [['gray', 6]], hasAudio: false });
const DRAIN_LIMIT_AFTER_END_MS = 10000 + 8000 + 15000;

const WIDTH = 480;
const HEIGHT = 270;
function solidFrame([r, g, b]) {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = r; data[offset + 1] = g; data[offset + 2] = b; data[offset + 3] = 255;
  }
  return { data, width: WIDTH, height: HEIGHT };
}
const GRAY = solidFrame([128, 128, 128]);
const createStillReader = () => ({ readFrameAt: async () => GRAY, close() {} });

function setupSimulator({
  mediaDurationMs = 6000, filePath = stillClipPath, handlerMap = {}, frameReader = createStillReader(),
  segmentList = [], segmentBufferMap = new Map(), options = {},
} = {}) {
  const clock = createVirtualClock({ startWallMs: 1_800_000_000_000 });
  const bridge = createFakeBridge({
    clock,
    handlerMap: {
      'pipeline-session-start': async () => ({ isOk: true, sessionId: 'session-test', recordPath: null }),
      'pipeline-session-end': async () => ({ isOk: true, sessionId: 'session-test', asrCount: 0, slideMarkCount: 0 }),
      'embed-frame': async () => ({ isOk: true, embedding: [1, 0, 0] }),
      ...handlerMap,
    },
  });
  const rendererListenerList = [];
  bridge.onRendererEvent = (channel, listener) => { if (channel === 'pipeline-event') rendererListenerList.push(listener); };
  const deliverCaptionAt = (atMs, payload) => clock.setTimeout(() => {
    for (const listener of rendererListenerList) listener({ payload, requestContext: null });
  }, atMs);
  const warnList = [];
  const progressList = [];
  const simulator = createSessionSimulator({
    clock, bridge,
    video: { videoId: 'clip', filePath, language: 'ko', probe: { durationMs: mediaDurationMs, width: 320, height: 180, hasAudio: false } },
    prep: { levelList: new Float32Array(Math.floor(mediaDurationMs / 100)), segmentList, segmentBufferMap, frameReader },
    options: { isPageTransitionIncluded: false, ffmpegPath, ...options },
    workDir: makeTempDir('factory-simulator-work-'),
    log: { log() {}, warn: (message) => warnList.push(message) },
    onProgress: (progress) => progressList.push(progress),
  });
  return { clock, bridge, simulator, deliverCaptionAt, warnList, progressList };
}

let nextTs = 1;
function buildCaption({ text, eventVideoTimeMs, durationMs = 1000 }) {
  nextTs += 1;
  return {
    type: 'caption', ts: 1_800_000_000_000 + nextTs, text, source: 'deixis', slideLabel: null, narrationClass: 'deixis',
    eventVideoTimeMs, wavData: createToneWav({ durationMs }), rationale: null,
  };
}

const debugList = ({ bridge }) => bridge.sendList.filter(({ channel }) => channel === 'pipeline-debug').map(({ payload }) => payload);
const invokeOf = ({ bridge }, channel) => bridge.invokeList.find((call) => call.channel === channel);

test('시작: 꺼 둔 분류 → 세션 시작 순서로 알리고, 화면 전환 기준 시각·실험 차례를 세우고 제품 문구로 캡처 시작을 남긴다', async () => {
  const harness = setupSimulator();
  await harness.simulator.start();
  const { debugCtx: ctx } = harness.simulator;
  assert.deepEqual(harness.bridge.invokeList.map(({ channel }) => channel), ['pipeline-feature-toggles', 'pipeline-session-start']);
  assert.deepEqual(harness.bridge.invokeList[0].payload.disabledClassList, ['page_transition', 'speaker_identity']);
  assert.deepEqual(harness.bridge.invokeList[1].payload, { mode: 'delayed', asrLanguage: 'ko' });
  assert.equal(ctx.state.currentSessionId, 'session-test');
  assert.equal(ctx.state.experimentSeq, 1);
  assert.equal(ctx.state.lastScreenTransitionAt, ctx.state.sessionStartPerf);
  assert.deepEqual([ctx.state.isCaptureActive, ctx.state.isSessionActive], [true, true]);
  const startDebug = debugList(harness).find(({ reason }) => reason === '캡처 시작');
  assert.match(startDebug.detail, /^모드=delayed · 시작 시점 = 회의 시작 시점\(0초\) · 앞 맥락 화면 전환 후 0초 \(상한 (\d+초|없음)\) · 뒤 맥락 \d+초 \(ASR 청크 \d+ms\(무음 절단 \d+ms 이후\) \+ look-ahead \d+ms \+ 보류 \d+ms\)$/);
});

test('막힌 작업이 없으면 지연 재생이 끝난 직후 배수를 마치고, 원음을 끝까지 틀며 진행 상황을 영상 길이 안에서 알린다', async () => {
  const harness = setupSimulator();
  await harness.simulator.start();
  const result = await harness.simulator.runToEnd();
  assert.equal(result.isDrainTimedOut, false);
  const endCall = invokeOf(harness, 'pipeline-session-end');
  assert.ok(endCall.atElapsedMs >= 16000 && endCall.atElapsedMs < 6000 + DRAIN_LIMIT_AFTER_END_MS, `세션 끝 ${endCall.atElapsedMs}`);
  assert.equal(result.drainLimitMs, DRAIN_LIMIT_AFTER_END_MS);
  assert.ok(Math.abs(summarizeTimeline(result.pieceList).sourceMediaMs - 6000) < 1);
  assert.deepEqual(harness.progressList[0], { videoTimeMs: 6000, durationMs: 6000, adCount: 0 });
  assert.deepEqual(result.endResult, { isOk: true, sessionId: 'session-test', asrCount: 0, slideMarkCount: 0 });
  const reasonList = debugList(harness).map(({ reason }) => reason);
  assert.ok(reasonList.indexOf('회의 캡처 정지') < reasonList.indexOf('세션 스냅샷 확정'));
  assert.equal(result.frameSourceError, null);
  assert.deepEqual(harness.warnList, []);
});

test('배수 상한은 실험실 규칙(영상 끝 + 지연 10초 + 대기 줄 TTL 8초 + 여유 15초)이다', async () => {
  const harness = setupSimulator({
    segmentList: [{ startMs: 1000, endMs: 3000, voicedMs: 2000, isVoiced: true }],
    segmentBufferMap: new Map([[1000, Buffer.from('voice')]]),
    handlerMap: { 'pipeline-audio': () => new Promise(() => {}) },
  });
  await harness.simulator.start();
  const result = await harness.simulator.runToEnd();
  assert.equal(result.isDrainTimedOut, true);
  assert.equal(invokeOf(harness, 'pipeline-session-end').atElapsedMs, 6000 + DRAIN_LIMIT_AFTER_END_MS);
  assert.equal(result.drainEndAfterVideoMs, DRAIN_LIMIT_AFTER_END_MS);
  assert.equal(harness.simulator.debugCtx.state.isSessionActive, false);
  assert.deepEqual([result.remainingTaskCount, result.inFlightCallCount], [1, 0], '상한에서 남은 렌더러 작업·진행 중 외부 호출 수');
  assert.equal(result.appendedTailMs, 0, '원음은 이미 끝까지 틀었다');
});

test('상한에 닿아도 AD 가 재생 중이면 끝날 때까지 기다리고, 그때 남은 영상 안 예약은 drain_timeout·영상 끝 뒤 예약은 after_end 로 남긴다', async () => {
  const harness = setupSimulator();
  harness.deliverCaptionAt(2000, buildCaption({ text: '긴 해설', eventVideoTimeMs: 1000, durationMs: 40000 }));
  harness.deliverCaptionAt(2500, buildCaption({ text: '영상 안 해설', eventVideoTimeMs: 4000 }));
  harness.deliverCaptionAt(2600, buildCaption({ text: '영상 끝 뒤 해설', eventVideoTimeMs: 7000 }));
  await harness.simulator.start();
  const result = await harness.simulator.runToEnd();
  assert.equal(result.isDrainTimedOut, true);
  assert.equal(result.adPlayList.length, 1);
  const [adPlay] = result.adPlayList;
  assert.ok(adPlay.atElapsedMs + 40000 > 6000 + DRAIN_LIMIT_AFTER_END_MS, '긴 해설이 상한을 넘겨 재생된다');
  assert.equal(invokeOf(harness, 'pipeline-session-end').atElapsedMs, adPlay.atElapsedMs + 40000 + 1000);
  assert.deepEqual(result.dropRecordList.map(({ text, reason }) => [text, reason]), [
    ['영상 안 해설', 'drain_timeout'], ['영상 끝 뒤 해설', 'after_end'],
  ]);
  // AD 판단·드롭은 실험실처럼 상한에서 멈추지만, 남은 원음은 1배속으로 조각표 끝에 붙여 끝까지 담는다.
  assert.equal(Math.round(summarizeTimeline(result.pieceList).sourceMediaMs), 6000);
  const tailPiece = result.pieceList.at(-1);
  assert.equal(tailPiece.kind, 'source');
  assert.equal(tailPiece.srcEndMs, 6000);
  assert.ok(result.appendedTailMs > 2000, `붙인 원음 ${result.appendedTailMs}ms`);
  assert.ok(Math.abs(tailPiece.srcEndMs - tailPiece.srcStartMs - result.appendedTailMs) < 1);
  assert.ok(Math.abs((tailPiece.outEndMs - tailPiece.outStartMs) - (tailPiece.srcEndMs - tailPiece.srcStartMs)) < 1, '1배속');
  assert.deepEqual([result.remainingTaskCount, result.inFlightCallCount], [0, 0]);
  assert.deepEqual(harness.warnList, [
    '[factory] 배수 상한(영상 끝 + 33000ms)에 닿아 멈춘다 — 남은 영상 안 해설은 drain_timeout 으로 기록',
    `[factory] 지연 재생이 영상 끝에 닿기 전에 멈춰 남은 원음 ${result.appendedTailMs}ms 를 1배속으로 결과 끝에 붙인다`,
  ]);
});

test('배수 상한에서 멈춰도 결과 mp3 에는 원음이 끝까지 들어가고 길이 공식(원음 + AD + 무음 − 회수)이 맞는다', { timeout: 60000 }, async () => {
  const toneClipPath = await createTestClip({ dirPath, fileName: 'tone.mp4', colorTimeline: [['gray', 6]], audioExpr: '0.3*sin(2*PI*330*t)' });
  const harness = setupSimulator({ filePath: toneClipPath });
  harness.deliverCaptionAt(2000, buildCaption({ text: '긴 해설', eventVideoTimeMs: 1000, durationMs: 40000 }));
  await harness.simulator.start();
  const result = await harness.simulator.runToEnd();
  assert.equal(result.isDrainTimedOut, true);
  const workDir = makeTempDir('factory-simulator-render-');
  const recordBySeq = new Map(result.captionRecordList.map((record) => [record.captionSeq, record]));
  const adPathByRef = new Map();
  for (const adPlay of result.adPlayList) {
    const adPath = path.join(workDir, `ad-${adPlay.captionSeq}.wav`);
    fs.writeFileSync(adPath, recordBySeq.get(adPlay.captionSeq).wavBytes);
    adPathByRef.set(adPlay.captionSeq, adPath);
  }
  const outPath = path.join(workDir, 'out.mp3');
  await renderOutputMp3({
    sourcePath: toneClipPath, hasSourceAudio: true, pieceList: result.pieceList, adPathByRef, outPath, workDir, sampleRate: 48000, channelCount: 2, ffmpegPath,
  });
  const summary = summarizeTimeline(result.pieceList);
  assert.equal(Math.round(summary.sourceMediaMs), 6000);
  const mp3Ms = Number((await runBinary({ binaryPath: ffprobePath, argList: ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outPath] })).toString()) * 1000;
  const formulaMs = summary.sourceMediaMs + summary.adTotalMs + summary.silenceTotalMs - summary.recoveredMs;
  assert.ok(Math.abs(mp3Ms - formulaMs) < 150, `mp3 ${mp3Ms} / 공식 ${formulaMs}`);
  // 끝 0.5초는 붙인 원음 꼬리(330Hz)다. 무음이면 꼬리를 빼먹은 것이다.
  const tailBytes = new Uint8Array(await runBinary({
    binaryPath: ffmpegPath, argList: ['-v', 'error', '-sseof', '-0.5', '-i', outPath, '-ac', '1', '-f', 'f32le', 'pipe:1'],
  }));
  const tailSampleList = new Float32Array(tailBytes.buffer, 0, Math.floor(tailBytes.length / 4));
  const rms = Math.sqrt(tailSampleList.reduce((sum, sample) => sum + sample * sample, 0) / tailSampleList.length);
  assert.ok(rms > 0.1, `끝 원음 RMS ${rms}`);
});

test('세션은 지연 재생이 끝난 뒤에도 남은 연결 작업이 끝날 때까지 살아 있다', async () => {
  let activeAtResolve = null;
  const harness = setupSimulator({
    segmentList: [{ startMs: 1000, endMs: 3000, voicedMs: 2000, isVoiced: true }],
    segmentBufferMap: new Map([[1000, Buffer.from('voice')]]),
    handlerMap: {
      'pipeline-audio': () => new Promise((resolve) => {
        harness.clock.setTimeout(() => { activeAtResolve = harness.simulator.debugCtx.state.isSessionActive; resolve({ isOk: true }); }, 20000);
      }),
    },
  });
  await harness.simulator.start();
  const result = await harness.simulator.runToEnd();
  assert.equal(result.isDrainTimedOut, false);
  assert.equal(activeAtResolve, true);
  assert.ok(invokeOf(harness, 'pipeline-session-end').atElapsedMs >= 23000);
});

test('영상 끝 직전 400ms 안에 바뀐 화면도 끝 뒤 두 tick(마지막 격자 칸)으로 슬라이드 전환을 확정하고, 그 뒤 샘플러는 멈춘다', async () => {
  const filePath = await createTestClip({ dirPath, fileName: 'late-change.mp4', colorTimeline: [['red', 5.3], ['blue', 0.7]], hasAudio: false });
  const { durationMs } = await probeVideo({ filePath, ffprobePath });
  const realReader = openSampleFrameReader({ filePath, ffmpegPath });
  const requestList = [];
  const frameReader = { readFrameAt: (timeMs) => { requestList.push(timeMs); return realReader.readFrameAt(timeMs); }, close: () => realReader.close() };
  const harness = setupSimulator({ mediaDurationMs: durationMs, filePath, frameReader, handlerMap: { 'embed-frame': async () => ({ isOk: false }) } });
  try {
    await harness.simulator.start();
    await harness.simulator.runToEnd();
  } finally {
    realReader.close();
  }
  const { state } = harness.simulator.debugCtx;
  assert.ok(state.slideEventVideoTimeMap.get('2') >= durationMs, `끝 뒤 확정한 슬라이드 2: ${state.slideEventVideoTimeMap.get('2')}`);
  const lastGridMs = Math.floor((durationMs - 1) / 400) * 400;
  assert.deepEqual(requestList.slice(-3), [lastGridMs, lastGridMs, lastGridMs]);
  assert.equal(Math.max(...requestList), lastGridMs);
  assert.equal(state.isCaptureActive, false);
});

test('프레임 읽기가 실제 시간 상한을 넘으면 세션을 실패로 끝낸다', async () => {
  let closeCount = 0;
  const harness = setupSimulator({
    frameReader: { readFrameAt: () => new Promise(() => {}), close: () => { closeCount += 1; } },
    options: { frameIoTimeoutMs: 300 },
  });
  await harness.simulator.start();
  await assert.rejects(harness.simulator.runToEnd(), /프레임 읽기가 실제 0\.3초 안에 끝나지 않았다/);
  assert.equal(closeCount, 1);
});

test('프레임 소스 오류는 세션을 끝까지 돌리고 결과에 오류와 영상 시각을 남긴다', async () => {
  const harness = setupSimulator({
    frameReader: {
      readFrameAt: async (timeMs) => {
        if (timeMs >= 2000) throw new Error('ffmpeg 프레임 디코드 실패(종료 코드 1)');
        return GRAY;
      },
      close() {},
    },
  });
  await harness.simulator.start();
  const result = await harness.simulator.runToEnd();
  assert.equal(result.isDrainTimedOut, false);
  assert.deepEqual(result.frameSourceError, { message: 'ffmpeg 프레임 디코드 실패(종료 코드 1)', videoTimeMs: 2000 });
  assert.equal(result.frameStats.captureFailCount, 0);
});
