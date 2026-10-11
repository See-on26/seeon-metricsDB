import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlaybackRecorder } from '../src/session/playback-recorder.mjs';
import { startPlaybackChain } from '../src/session/playback-chain.mjs';
import { createOutputGlue } from '../src/session/output-glue.mjs';
import { createTestContext } from './helpers/session-fakes.mjs';
import { createToneWav } from './helpers/mock-services.mjs';
import {
  isAudioGapActive, buildInsertionGapList, resolveInsertionTargetMs, GAP_CANDIDATE_SOURCE_MAP,
} from '../seeon-meet/src/renderer/core/audio-renderer/audio-gap-candidates.js';

// 캡션에는 소리가 없다. 렌더러가 재생 차례가 가까운 해설만 pipeline-tts 로 합성한다. 대역 TTS 는 캡션 문장마다 정해 둔 길이의
// wav 를 돌려주고(같은 문장은 같은 버퍼), 실패로 정해 둔 문장은 제품 핸들러처럼 { isOk: false, message } 로 답한다.
// ttsDelayMs 를 주면 합성이 그만큼 가상 시간을 쓴다.
function createFakeTts({ clock, ttsDelayMs = 0 }) {
  const wavByText = new Map();
  const failedTextSet = new Set();
  return {
    wavByText, failedTextSet,
    handler: async ({ text }) => {
      if (ttsDelayMs > 0) await new Promise((resolve) => { clock.setTimeout(resolve, ttsDelayMs); });
      if (failedTextSet.has(text)) return { isOk: false, message: 'TTS HTTP 500' };
      return { isOk: true, wavData: wavByText.get(text) ?? createToneWav({ durationMs: 1500 }) };
    },
  };
}

function setupOutput({ handlerMap = {}, mediaDurationMs = 60000, isPageTransitionIncluded = false, ttsDelayMs = 0 } = {}) {
  let fakeTts = null;
  const harness = createTestContext({
    mediaDurationMs, isPageTransitionIncluded, handlerMap: { 'pipeline-tts': (payload) => fakeTts.handler(payload), ...handlerMap },
  });
  fakeTts = createFakeTts({ clock: harness.clock, ttsDelayMs });
  const recorder = createPlaybackRecorder();
  const outputGlue = createOutputGlue({ ctx: harness.ctx });
  const chain = startPlaybackChain({
    ctx: harness.ctx, recorder, onAdStart: outputGlue.noteAdStart, onNarrationDrop: outputGlue.handleNarrationDrop,
    prepareAudio: outputGlue.prepareNarrationAudio,
  });
  return { ...harness, recorder, outputGlue, chain, fakeTts };
}

let nextTs = 1;
function buildCaption(harness, { text, eventVideoTimeMs, narrationClass = 'deixis', source = 'deixis', durationMs = 1500, hasWav = true, slideLabel = null }) {
  nextTs += 1;
  harness.fakeTts.wavByText.set(text, createToneWav({ durationMs }));
  if (!hasWav) harness.fakeTts.failedTextSet.add(text);
  return {
    type: 'caption', ts: 1_800_000_000_000 + nextTs, text, source, slideLabel, narrationClass, eventVideoTimeMs,
    rationale: { utterance: '이 그래프를 보시면', subKind: null, summary: '근거 표현=이 그래프' },
  };
}
const requestContext = { seq: 9, channel: 'pipeline-deixis', callList: [{ service: 'vlm', modelId: 'qwen', isVlmFallback: false }] };
const deliverAt = (harness, atMs, captionOption) => {
  const payload = buildCaption(harness, captionOption);
  harness.clock.setTimeout(() => harness.outputGlue.handleCaptionEvent({ payload, requestContext }), atMs);
  return payload;
};
const deliverNow = (harness, captionOption) => harness.outputGlue.handleCaptionEvent({ payload: buildCaption(harness, captionOption), requestContext });
const dropReportList = (harness) => harness.bridge.sendList.filter(({ channel }) => channel === 'pipeline-narration-dropped').map(({ payload }) => payload);
const ttsCallList = (harness) => harness.bridge.invokeList.filter(({ channel }) => channel === 'pipeline-tts');
const listDrop = (harness) => harness.outputGlue.getDropRecordList().map(({ text, reason, factoryReason }) => [text, reason, factoryReason]);

test('지시 해설은 틈 후보 중 Bedrock 이 고른 자리에 넣고, 재생헤드가 닿으면 원음을 멈추고 튼다', async () => {
  const harness = setupOutput({ handlerMap: { 'pipeline-gap': async () => ({ isOk: true, gapIndex: 0, source: 'bedrock', reason: '문장 끝' }) } });
  harness.ctx.core.gapCandidateStore.add({ videoTimeMs: 12500, kind: 'complete', silenceMs: 400, text: '매출이 늘었습니다.' });
  harness.ctx.core.gapCandidateStore.add({ videoTimeMs: 14000, kind: 'pause', silenceMs: 600, text: '그리고' });
  deliverAt(harness, 16000, { text: '막대 그래프 상승 구간', eventVideoTimeMs: 12000 });
  await harness.clock.runUntil({ isDone: () => harness.outputGlue.getAdPlayList().length === 1 });
  const gapCall = harness.bridge.invokeList.find((call) => call.channel === 'pipeline-gap');
  assert.deepEqual(gapCall.payload.gapList.map((gap) => gap.videoTimeMs), [12500, 14000]);
  assert.equal(gapCall.payload.mode, 'delayed');
  assert.equal(gapCall.payload.narrationType, 'deixis');
  const [record] = harness.outputGlue.getCaptionRecordList();
  assert.equal(record.insertVideoTimeMs, 12500);
  assert.equal(record.gap.source, 'bedrock');
  assert.equal(record.callList[0].service, 'vlm');
  assert.equal(record.audioDurationMs, 1500);
  const [adPlay] = harness.outputGlue.getAdPlayList();
  assert.equal(adPlay.captionSeq, record.captionSeq);
  assert.ok(adPlay.playedMediaMs >= 12500 && adPlay.playedMediaMs <= 12700, `재생 위치 ${adPlay.playedMediaMs}`);
  // 캡션이 도착하면 재생 차례 전에 미리 합성한다(2개까지). 차례가 왔을 때 소리가 이미 있어 기다리지 않는다.
  assert.deepEqual(ttsCallList(harness).map(({ payload, atElapsedMs }) => [payload.text, payload.source, atElapsedMs]), [['막대 그래프 상승 구간', 'deixis', 16000]]);
  assert.deepEqual([record.tts.isOk, record.tts.isOnDemand, record.ttsWaitMs], [true, false, 0]);
});

test('무발화 해설은 틈을 고르지 않고 감지 시점에 넣는다', async () => {
  const harness = setupOutput();
  deliverAt(harness, 21000, { text: '여행 사진 묘사', eventVideoTimeMs: 20000, narrationClass: 'silence_based', source: 'visual_description' });
  await harness.clock.runUntil({ isDone: () => harness.outputGlue.getAdPlayList().length === 1 });
  assert.equal(harness.bridge.invokeList.some((call) => call.channel === 'pipeline-gap'), false);
  assert.equal(harness.outputGlue.getCaptionRecordList()[0].insertVideoTimeMs, 20000);
});

test('누적 지연이 6초를 넘으면 캡션을 버리고 delay_exceeded 로 main 에 알려 "말했음" 기록을 되돌린다', async () => {
  const harness = setupOutput();
  deliverAt(harness, 2000, { text: '긴 해설', eventVideoTimeMs: 1000, durationMs: 7500 });
  deliverAt(harness, 18000, { text: '늦은 해설', eventVideoTimeMs: 17000 });
  await harness.clock.runUntil({ isDone: () => harness.outputGlue.getDropRecordList().length === 1, deadlineElapsedMs: 30000 });
  assert.deepEqual(listDrop(harness), [['늦은 해설', 'delay_exceeded', null]]);
  assert.deepEqual(dropReportList(harness).map(({ text, reason }) => [text, reason]), [['늦은 해설', 'delay_exceeded']]);
  const debug = harness.bridge.sendList.find(({ channel, payload }) => channel === 'pipeline-debug' && payload.reason === '누적 지연 상한 초과 — 해설 버림');
  assert.match(debug.payload.detail, / · 초과 \d+ms \/ 상한 6000ms · 모드=delayed$/);
});

test('꺼진 분류(화자 식별)는 대기 줄에서 feature_off 로 버리고 main 에 알린다', async () => {
  const harness = setupOutput();
  deliverAt(harness, 15000, { text: '발표자 홍길동', eventVideoTimeMs: 14000, narrationClass: 'speaker_identity', source: 'speaker_identity' });
  await harness.clock.runUntil({ isDone: () => harness.outputGlue.getDropRecordList().length === 1 });
  assert.equal(harness.outputGlue.getDropRecordList()[0].reason, 'feature_off');
  const report = harness.bridge.sendList.find(({ channel }) => channel === 'pipeline-narration-dropped');
  assert.equal(report.payload.reason, 'feature_off');
  assert.equal(report.payload.text, '발표자 홍길동');
});

test('TTS 가 실패하면 재생기가 소리 없이 건너뛰고 tts_failed 로 main 에 알리며, 멈췄던 지연 재생은 다시 흐른다', async () => {
  const harness = setupOutput();
  deliverAt(harness, 15000, { text: '소리 없는 해설', eventVideoTimeMs: 14000, hasWav: false });
  await harness.clock.runUntil({ isDone: () => harness.outputGlue.getDropRecordList().length === 1 });
  assert.deepEqual(listDrop(harness), [['소리 없는 해설', 'tts_failed', null]]);
  assert.deepEqual(dropReportList(harness).map(({ reason }) => reason), ['tts_failed']);
  assert.equal(harness.outputGlue.getAdPlayList().length, 0);
  const [record] = harness.outputGlue.getCaptionRecordList();
  assert.deepEqual([record.hasAudio, record.wavBytes, record.tts.isOk, record.tts.message], [false, null, false, 'TTS HTTP 500']);
  await harness.clock.runUntil({ isDone: () => harness.clock.elapsedMs() >= 30000 });
  assert.equal(harness.ctx.core.delayBuffer.delayedVideo.paused, false);
});

test('미리 만들기 자리(2개) 밖에서 차례가 먼저 온 해설은 그때 합성하고, 합성하는 동안 지연 재생은 멈춰 그만큼 무음이 된다', async () => {
  const harness = setupOutput({ ttsDelayMs: 700 });
  // 도착 순서는 A·B·C 이고 C 의 자리가 가장 이르다. A·B 는 도착 때 미리 합성하고, C 는 자리가 나기 전에 차례가 온다.
  deliverAt(harness, 16000, { text: 'A 해설', eventVideoTimeMs: 30000, narrationClass: 'silence_based', source: 'visual_description' });
  deliverAt(harness, 16000, { text: 'B 해설', eventVideoTimeMs: 31000, narrationClass: 'silence_based', source: 'visual_description' });
  deliverAt(harness, 16000, { text: 'C 해설', eventVideoTimeMs: 12000, narrationClass: 'silence_based', source: 'visual_description', durationMs: 1000 });
  await harness.clock.runUntil({ isDone: () => harness.outputGlue.getAdPlayList().length === 1 });
  const recordByText = new Map(harness.outputGlue.getCaptionRecordList().map((record) => [record.text, record]));
  const recordC = recordByText.get('C 해설');
  assert.deepEqual(ttsCallList(harness).map(({ payload }) => payload.text), ['A 해설', 'B 해설', 'C 해설']);
  assert.deepEqual(['A 해설', 'B 해설'].map((text) => recordByText.get(text).tts.isOnDemand), [false, false]);
  assert.deepEqual([recordC.tts.isOnDemand, recordC.ttsWaitMs], [true, 700]);
  const [adPlay] = harness.outputGlue.getAdPlayList();
  assert.equal(adPlay.captionSeq, recordC.captionSeq);
  harness.recorder.close({ atElapsedMs: harness.clock.elapsedMs(), mediaMs: harness.ctx.core.delayBuffer.getDelayedTimeMs() });
  const pieceList = harness.recorder.getPieceList();
  const adIndex = pieceList.findIndex((piece) => piece.kind === 'ad');
  const silence = pieceList[adIndex - 1];
  assert.equal(silence.kind, 'silence');
  assert.ok(Math.abs((silence.outEndMs - silence.outStartMs) - 720) < 1, `합성 대기 700ms + 재생 예약 20ms 무음: ${silence.outEndMs - silence.outStartMs}`);
  assert.deepEqual(harness.warnList, []);
});

test('영상 끝 뒤로 잡힌 예약은 세션을 멈출 때 stopped 로 main 에 알리고 공장 사유 after_end 로 남긴다', async () => {
  const harness = setupOutput({ mediaDurationMs: 20000 });
  deliverNow(harness, { text: '끝 뒤 해설', eventVideoTimeMs: 21000, narrationClass: 'silence_based', source: 'visual_description' });
  await harness.clock.runUntil({ isDone: () => harness.ctx.core.narrationScheduler.pendingCount === 1 });
  harness.outputGlue.noteSessionEnd();
  harness.chain.stop();
  assert.deepEqual(listDrop(harness), [['끝 뒤 해설', 'stopped', 'after_end']]);
  assert.deepEqual(dropReportList(harness).map(({ text, reason }) => [text, reason]), [['끝 뒤 해설', 'stopped']]);
});

const PRODUCT_SOURCE_MARK = '/seeon-meet/src/';
const WATCH_STACK_TRACE_LIMIT = 50;

// 지연 버퍼·대기 줄·체류·지시 후보·진행 중 전환(10초 상한)·TTS 미리 만들기를 모두 쓰는 장면.
// 해설이 끝난 뒤 따라잡기 갈래(caption-narrator.js _startCatchup)까지 지난다.
async function runWatchedScenario() {
  const harness = setupOutput({ handlerMap: { 'pipeline-gap': async () => ({ isOk: true, gapIndex: 0, source: 'bedrock', reason: '' }) } });
  harness.ctx.core.gapCandidateStore.add({ videoTimeMs: 12500, kind: 'complete', silenceMs: 400, text: '끝.' });
  deliverAt(harness, 16000, { text: '해설', eventVideoTimeMs: 12000 });
  harness.ctx.core.candidateScheduler.submit({ source: 'speech', utterance: '이것', trigger: '이것', captureTs: harness.clock.nowPerf(), videoTimeMs: 0 });
  harness.ctx.core.slideDwellGate.enter({ label: '1' });
  harness.ctx.core.pendingTransitions.open({ slideLabel: '1' });
  return harness.clock.runUntil({
    isDone: () => harness.outputGlue.getAdPlayList().length === 1 && !harness.ctx.core.narrator.currentEntry && harness.clock.elapsedMs() >= 25000,
    deadlineElapsedMs: 60000,
  });
}

// 감시 중 오류가 나도 감시 결과를 먼저 단언한다. 가상 시계 오류보다 새어 나간 자리의 스택이 원인을 바로 보여 준다.
async function runUnderWatch({ install, uninstall, readFindingList }) {
  const originalStackTraceLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = WATCH_STACK_TRACE_LIMIT;
  let outcome = null;
  let runError = null;
  install();
  try {
    outcome = await runWatchedScenario();
  } catch (error) {
    runError = error;
  } finally {
    uninstall();
    Error.stackTraceLimit = originalStackTraceLimit;
  }
  assert.deepEqual(readFindingList(), []);
  if (runError) throw runError;
  assert.equal(outcome, 'done');
}

test('시뮬레이션 동안 seeon-meet 코드가 실제 setTimeout/setInterval 을 만들지 않는다', async () => {
  const leakList = [];
  const leakedHandleList = [];
  const originalMap = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval };
  const watch = (name) => function watchedTimer(...argList) {
    const handle = originalMap[name].apply(this, argList);
    const stack = new Error().stack || '';
    if (stack.includes(PRODUCT_SOURCE_MARK)) {
      leakList.push(`${name}\n${stack}`);
      leakedHandleList.push(handle);
    }
    return handle;
  };
  await runUnderWatch({
    install() {
      globalThis.setTimeout = watch('setTimeout');
      globalThis.setInterval = watch('setInterval');
    },
    // 새어 나간 실제 타이머가 남으면 테스트 프로세스가 끝나지 않으므로 감시를 풀 때 모두 지운다.
    uninstall() {
      globalThis.setTimeout = originalMap.setTimeout;
      globalThis.setInterval = originalMap.setInterval;
      for (const handle of leakedHandleList) clearTimeout(handle);
    },
    readFindingList: () => leakList,
  });
});

// 가상 시계는 외부 호출 중 performance.now 로 흐른다. 그 경로와 섞이지 않게 실제 시계를 직접 부른 자리가 제품 파일일 때만 센다.
test('시뮬레이션 동안 seeon-meet 코드가 실제 performance.now/Date.now 를 읽지 않는다', async () => {
  const readList = [];
  const originalDateNow = Date.now;
  const watch = ({ name, read }) => function watchedNow() {
    const holder = {};
    Error.captureStackTrace(holder, watchedNow);
    const callerLine = holder.stack.split('\n')[1] || '';
    if (callerLine.includes(PRODUCT_SOURCE_MARK)) readList.push(`${name}\n${holder.stack}`);
    return read();
  };
  const originalPerformanceNow = performance.now;
  await runUnderWatch({
    install() {
      performance.now = watch({ name: 'performance.now', read: () => originalPerformanceNow.call(performance) });
      Date.now = watch({ name: 'Date.now', read: () => originalDateNow.call(Date) });
    },
    uninstall() {
      delete performance.now;
      Date.now = originalDateNow;
    },
    readFindingList: () => readList,
  });
  assert.equal(performance.now, originalPerformanceNow);
});

const debugReasonList = (harness) => harness.bridge.sendList.filter(({ channel }) => channel === 'pipeline-debug').map(({ payload }) => payload.reason);

test('전환 고지는 체류 판정을 기다리고, 미달이면 고지와 딸린 사진 묘사를 함께 버린다', async () => {
  const harness = setupOutput({ isPageTransitionIncluded: true });
  harness.ctx.core.slideDwellGate.enter({ label: '2' });
  deliverAt(harness, 500, { text: '2번 슬라이드, 매출 추이', eventVideoTimeMs: 400, narrationClass: 'page_transition', source: 'page-transition', slideLabel: '2' });
  deliverAt(harness, 600, { text: '여행 사진', eventVideoTimeMs: 400, narrationClass: 'page_transition', source: 'visual_description', slideLabel: '2' });
  harness.clock.setTimeout(() => harness.ctx.core.slideDwellGate.enter({ label: '3' }), 1000);
  await harness.clock.runUntil({ isDone: () => harness.outputGlue.getDropRecordList().length === 2 });
  assert.deepEqual(listDrop(harness), [['2번 슬라이드, 매출 추이', 'dwell_cancelled', null], ['여행 사진', 'leader_cancelled', null]]);
  assert.deepEqual(dropReportList(harness).map(({ reason }) => reason), ['dwell_cancelled', 'leader_cancelled'], '취소도 main 에 알려 "말했음" 기록을 되돌린다');
  assert.ok(debugReasonList(harness).includes('체류 미달 — 전환 고지 취소'));
  assert.ok(debugReasonList(harness).includes('전환 고지 취소 — 딸린 사진 묘사도 버림'));
  assert.equal(ttsCallList(harness).length, 0, '체류를 못 채운 고지와 딸린 묘사는 합성하지 않는다');
  assert.equal(harness.bridge.invokeList.some((call) => call.channel === 'pipeline-gap'), false);
  assert.equal(harness.outputGlue.getAdPlayList().length, 0);
  assert.deepEqual(harness.warnList, []);
});

test('체류를 채운 전환 고지가 틈을 고르면 딸린 사진 묘사는 그 바로 뒤(+1ms)에 붙어 고지 다음에 재생된다', async () => {
  const harness = setupOutput({ isPageTransitionIncluded: true, handlerMap: { 'pipeline-gap': async () => ({ isOk: true, gapIndex: 0, source: 'bedrock', reason: '전환 뒤 첫 쉼' }) } });
  harness.ctx.core.slideDwellGate.enter({ label: '2' });
  harness.ctx.core.gapCandidateStore.add({ videoTimeMs: 2500, kind: 'complete', silenceMs: 500, text: '넘어가겠습니다.' });
  deliverAt(harness, 3500, { text: '2번 슬라이드, 매출 추이', eventVideoTimeMs: 400, narrationClass: 'page_transition', source: 'page-transition', slideLabel: '2' });
  deliverAt(harness, 3500, { text: '여행 사진', eventVideoTimeMs: 400, narrationClass: 'page_transition', source: 'visual_description', slideLabel: '2' });
  await harness.clock.runUntil({ isDone: () => harness.outputGlue.getAdPlayList().length === 2 });
  const [leader, follower] = harness.outputGlue.getCaptionRecordList();
  assert.deepEqual([leader.insertVideoTimeMs, follower.insertVideoTimeMs], [2500, 2501]);
  assert.equal(follower.gap, null);
  const gapCallList = harness.bridge.invokeList.filter((call) => call.channel === 'pipeline-gap');
  assert.equal(gapCallList.length, 1);
  assert.equal(gapCallList[0].payload.narrationType, 'page_transition');
  assert.equal(gapCallList[0].payload.screenSummary, '슬라이드 2 — 2번 슬라이드, 매출 추이');
  assert.deepEqual(harness.outputGlue.getAdPlayList().map(({ captionSeq }) => captionSeq), [leader.captionSeq, follower.captionSeq]);
  assert.deepEqual(harness.outputGlue.getDropRecordList(), []);
  assert.deepEqual(harness.warnList, []);
});

test('전환 고지의 삽입 시각이 정해지면 진행 중인 전환을 풀고, 그동안 기다린 화자 안내는 그 고지 바로 뒤(+1ms)로 미룬다', async () => {
  const harness = setupOutput({ isPageTransitionIncluded: true, handlerMap: { 'pipeline-gap': async () => ({ isOk: true, gapIndex: 0, source: 'bedrock', reason: '전환 뒤 첫 쉼' }) } });
  const { core } = harness.ctx;
  core.slideDwellGate.enter({ label: '2' });
  core.pendingTransitions.open({ slideLabel: '2' });
  core.gapCandidateStore.add({ videoTimeMs: 2500, kind: 'complete', silenceMs: 500, text: '넘어가겠습니다.' });
  deliverAt(harness, 1000, { text: '발표자 홍길동', eventVideoTimeMs: 900, narrationClass: 'speaker_identity', source: 'speaker_identity' });
  deliverAt(harness, 3500, { text: '2번 슬라이드, 매출 추이', eventVideoTimeMs: 400, narrationClass: 'page_transition', source: 'page-transition', slideLabel: '2' });
  await harness.clock.runUntil({ isDone: () => harness.outputGlue.getCaptionRecordList().every((record) => record.insertVideoTimeMs !== null) && harness.outputGlue.getCaptionRecordList().length === 2 });
  const [speaker, leader] = harness.outputGlue.getCaptionRecordList();
  assert.equal(leader.insertVideoTimeMs, 2500);
  assert.equal(speaker.insertVideoTimeMs, 2501);
  assert.equal(core.pendingTransitions.hasPending, false);
  assert.ok(debugReasonList(harness).includes('진행 중인 화면 전환 고지 뒤로 화자 안내를 미룸'));
  assert.deepEqual(harness.warnList, []);
});

test('틈 추론이 실패하면 트리거 지점에 넣고 실패한 추론 결과를 기록에 남긴다', async () => {
  const harness = setupOutput({ handlerMap: { 'pipeline-gap': async () => { throw new Error('bedrock 끊김'); } } });
  harness.ctx.core.gapCandidateStore.add({ videoTimeMs: 12500, kind: 'complete', silenceMs: 400, text: '매출이 늘었습니다.' });
  deliverAt(harness, 16000, { text: '막대 그래프 상승 구간', eventVideoTimeMs: 12000 });
  await harness.clock.runUntil({ isDone: () => harness.outputGlue.getAdPlayList().length === 1 });
  const [record] = harness.outputGlue.getCaptionRecordList();
  assert.equal(record.insertVideoTimeMs, 12000);
  assert.deepEqual(record.gap, { source: null, reason: null, gapIndex: null, candidateCount: 1, callList: [] });
  assert.ok(harness.outputGlue.getAdPlayList()[0].playedMediaMs >= 12000 && harness.outputGlue.getAdPlayList()[0].playedMediaMs <= 12200);
  assert.deepEqual(harness.warnList, []);
});

test('배수 뒤 도착한 해설은 합성하지 않고 stopped(공장 after_end)로 버리고, stop 은 재생 사슬의 가상 타이머를 모두 거둔다', async () => {
  const harness = setupOutput({ mediaDurationMs: 20000 });
  deliverAt(harness, 5000, { text: '첫 해설', eventVideoTimeMs: 4000 });
  await harness.clock.runUntil({ isDone: () => harness.clock.elapsedMs() >= 16000 });
  assert.equal(harness.outputGlue.getAdPlayList().length, 1);
  harness.outputGlue.noteSessionEnd();
  harness.recorder.close({ atElapsedMs: harness.clock.elapsedMs(), mediaMs: harness.ctx.core.delayBuffer.getDelayedTimeMs() });
  harness.chain.stop();
  assert.deepEqual(harness.outputGlue.getDropRecordList(), []);
  deliverNow(harness, { text: '늦게 온 해설', eventVideoTimeMs: 15000 });
  await harness.clock.runUntil({ isDone: () => harness.outputGlue.getDropRecordList().length === 1, deadlineElapsedMs: harness.clock.elapsedMs() + 5000 });
  assert.deepEqual(listDrop(harness), [['늦게 온 해설', 'stopped', 'after_end']]);
  assert.deepEqual(ttsCallList(harness).map(({ payload }) => payload.text), ['첫 해설']);
  assert.equal(harness.ctx.core.narrationScheduler.pendingCount, 0);
  assert.equal(harness.clock.pendingTimerCount, 0);
  const pieceList = harness.recorder.getPieceList();
  assert.equal(pieceList[0].kind, 'source');
  assert.equal(pieceList[0].srcStartMs, 0);
  assert.ok(pieceList[0].srcEndMs >= 4000 && pieceList[0].srcEndMs <= 4200, `첫 원음 끝 ${pieceList[0].srcEndMs}`);
  const adPieceList = pieceList.filter((piece) => piece.kind === 'ad');
  assert.deepEqual(adPieceList.map(({ adRef, outStartMs, outEndMs }) => [adRef, outEndMs - outStartMs]), [[1, 1500]]);
  assert.deepEqual(harness.warnList, []);
});

test('배수 상한에 닿아 멈추면 남은·늦게 온 해설은 모두 stopped 로 main 에 알리고, 공장 사유는 영상 안 자리 drain_timeout·영상 끝 뒤 자리 after_end 다', async () => {
  const harness = setupOutput({ mediaDurationMs: 20000 });
  deliverNow(harness, { text: '영상 안 예약', eventVideoTimeMs: 15000 });
  deliverNow(harness, { text: '영상 끝 뒤 예약', eventVideoTimeMs: 21000 });
  await harness.clock.runUntil({ isDone: () => harness.ctx.core.narrationScheduler.pendingCount === 2 });
  harness.outputGlue.noteSessionEnd({ isDrainTimedOut: true });
  harness.chain.stop();
  deliverNow(harness, { text: '늦게 온 영상 안 해설', eventVideoTimeMs: 12000 });
  deliverNow(harness, { text: '늦게 온 영상 끝 뒤 해설', eventVideoTimeMs: 25000 });
  await harness.clock.runUntil({ isDone: () => harness.outputGlue.getDropRecordList().length === 4, deadlineElapsedMs: harness.clock.elapsedMs() + 5000 });
  assert.deepEqual(listDrop(harness), [
    ['영상 안 예약', 'stopped', 'drain_timeout'], ['영상 끝 뒤 예약', 'stopped', 'after_end'],
    ['늦게 온 영상 안 해설', 'stopped', 'drain_timeout'], ['늦게 온 영상 끝 뒤 해설', 'stopped', 'after_end'],
  ]);
  assert.deepEqual(dropReportList(harness).map(({ reason }) => reason), ['stopped', 'stopped', 'stopped', 'stopped']);
  assert.deepEqual(harness.warnList, []);
});

test('세션을 멈출 때 소리 나기 전(합성 중) 해설·대기 줄 해설도 stopped 로 알리고 미리 만들기 자리를 비운다', async () => {
  const harness = setupOutput({ ttsDelayMs: 5000 });
  deliverNow(harness, { text: '합성 중 해설', eventVideoTimeMs: 0, narrationClass: 'silence_based', source: 'visual_description' });
  await harness.clock.runUntil({ isDone: () => Boolean(harness.ctx.core.narrator.currentEntry) });
  harness.outputGlue.noteSessionEnd({ isDrainTimedOut: true });
  harness.chain.stop();
  assert.deepEqual(listDrop(harness), [['합성 중 해설', 'stopped', 'drain_timeout']]);
  assert.deepEqual(harness.ctx.core.narrationAudio.aheadKeyList, []);
  await harness.clock.runUntil({ isDone: () => harness.ctx.getTaskCount() === 0 });
  assert.equal(harness.outputGlue.getAdPlayList().length, 0, '멈춘 뒤 끝난 합성은 재생하지 않는다');
  assert.equal(harness.outputGlue.getCaptionRecordList()[0].wavBytes, null, '버린 해설의 소리는 붙잡지 않는다');
  assert.deepEqual(harness.warnList, []);
});

test('세션을 멈춘 순간 합성 상태를 확정한다: 그때 끝나지 않은 합성과 정지 정리 중 시작된 합성은 나중에 응답이 와도 기록을 바꾸지 않는다', async () => {
  const harness = setupOutput({ ttsDelayMs: 5000 });
  // 넷 다 자리가 이미 지나 바로 재생 차례가 온다. 첫째는 재생기가 합성을 기다리는 중, 둘째·셋째는 미리 만드는 중, 넷째는 자리를 기다린다.
  const textList = ['합성 중 해설', '미리 만드는 해설', '또 미리 만드는 해설', '자리 기다리는 해설'];
  for (const text of textList) deliverNow(harness, { text, eventVideoTimeMs: 0, narrationClass: 'silence_based', source: 'visual_description' });
  await harness.clock.runUntil({ isDone: () => Boolean(harness.ctx.core.narrator.currentEntry) });
  assert.deepEqual(ttsCallList(harness).map(({ payload }) => payload.text), textList.slice(0, 3));
  harness.outputGlue.noteSessionEnd({ isDrainTimedOut: true });
  harness.chain.stop();
  harness.outputGlue.settleTtsAtStop();
  // 버린 해설이 미리 만들기 자리를 넘겨 정지 정리 중에도 넷째 합성이 시작된다(제품과 같다).
  await harness.clock.runUntil({ isDone: () => harness.ctx.getTaskCount() === 0 });
  assert.deepEqual(ttsCallList(harness).map(({ payload }) => payload.text), textList);
  for (const record of harness.outputGlue.getCaptionRecordList()) {
    assert.deepEqual([record.text, record.tts.isPendingAtStop, record.tts.isOk, record.tts.elapsedMs, record.hasAudio, record.wavBytes],
      [record.text, true, false, null, false, null], '정지 뒤 응답은 기록에 반영하지 않는다');
  }
  assert.equal(harness.outputGlue.getAdPlayList().length, 0);
  assert.deepEqual(harness.warnList, []);
});

test('세션을 멈추기 전에 끝난 합성은 확정 상태(성공·실패)를 그대로 둔다', async () => {
  const harness = setupOutput();
  deliverAt(harness, 15000, { text: '재생한 해설', eventVideoTimeMs: 14000 });
  deliverAt(harness, 15000, { text: '실패한 해설', eventVideoTimeMs: 14500, hasWav: false });
  await harness.clock.runUntil({ isDone: () => harness.outputGlue.getAdPlayList().length === 1 && harness.outputGlue.getDropRecordList().length === 1 });
  harness.outputGlue.noteSessionEnd();
  harness.chain.stop();
  harness.outputGlue.settleTtsAtStop();
  assert.deepEqual(harness.outputGlue.getCaptionRecordList().map(({ text, tts }) => [text, tts.isOk, tts.isPendingAtStop]),
    [['재생한 해설', true, false], ['실패한 해설', false, false]]);
});

test('영상 끝 직후 도착한 캡션은 delay_exceeded 로 버려지지 않고 재생되며, 끝 구간 원음이 1.5배속으로 뛰지 않는다', async () => {
  const harness = setupOutput({ mediaDurationMs: 20000 });
  const { core } = harness.ctx;
  const rateList = [];
  harness.clock.setTimeout(() => core.delaySource.enterTailMode(), 20000);
  const rateProbe = harness.clock.setInterval(() => {
    if (harness.clock.elapsedMs() > 20000 && !harness.outputGlue.getAdPlayList().length) rateList.push(core.delayBuffer.delayedVideo.playbackRate);
  }, 250);
  deliverAt(harness, 20500, { text: '끝 직후 도착한 해설', eventVideoTimeMs: 18000 });
  await harness.clock.runUntil({ isDone: () => harness.outputGlue.getAdPlayList().length === 1, deadlineElapsedMs: 40000 });
  harness.clock.clearInterval(rateProbe);
  assert.deepEqual(harness.outputGlue.getDropRecordList(), []);
  const [adPlay] = harness.outputGlue.getAdPlayList();
  assert.ok(adPlay.playedMediaMs >= 18000 && adPlay.playedMediaMs <= 18200, `재생 위치 ${adPlay.playedMediaMs}`);
  assert.ok(rateList.length > 20, `표본 ${rateList.length}개`);
  assert.equal(Math.max(...rateList), 1);
  assert.deepEqual(harness.warnList, []);
});

test('지연 재생 요소가 끝난 지 6초 넘어 도착한 끝 구간 캡션도 delay_exceeded 로 버리지 않고 끝 자리에 재생한다', async () => {
  const harness = setupOutput({ mediaDurationMs: 20000 });
  const { core } = harness.ctx;
  harness.clock.setTimeout(() => core.delaySource.enterTailMode(), 20000);
  deliverAt(harness, 37000, { text: '끝 구간 늦은 해설', eventVideoTimeMs: 19000 });
  await harness.clock.runUntil({
    isDone: () => harness.outputGlue.getAdPlayList().length + harness.outputGlue.getDropRecordList().length === 1, deadlineElapsedMs: 60000,
  });
  assert.equal(core.delayBuffer.delayedVideo.ended, true);
  assert.deepEqual(harness.outputGlue.getDropRecordList(), []);
  const [adPlay] = harness.outputGlue.getAdPlayList();
  assert.equal(Math.round(adPlay.playedMediaMs), 20000);
  assert.ok(adPlay.atElapsedMs >= 37000);
  assert.ok(core.delayBuffer.getExcessMs() < 1000, `끝난 뒤 초과 지연이 자라지 않는다: ${core.delayBuffer.getExcessMs()}`);
  assert.deepEqual(harness.warnList, []);
});

test('캡션 발행 중 오류가 나면 재생도 드롭도 아닌 채 남기지 않고 emit_failed 로 main 에 알린다', async () => {
  const harness = setupOutput();
  harness.ctx.core.gapCandidateStore.getCandidateList = () => { throw new Error('후보 표 손상'); };
  deliverAt(harness, 16000, { text: '발행 실패 해설', eventVideoTimeMs: 12000 });
  await harness.clock.runUntil({ isDone: () => harness.clock.elapsedMs() >= 16000 && harness.ctx.getTaskCount() === 0 });
  assert.deepEqual(listDrop(harness), [['발행 실패 해설', 'emit_failed', null]]);
  assert.deepEqual(dropReportList(harness).map(({ reason }) => reason), ['emit_failed']);
  assert.deepEqual(harness.warnList, ['[factory] caption 실패(무시): 후보 표 손상']);
});

test('재생한 캡션은 wav 를 복사 없이 참조로 두고, 버린 캡션은 wav 를 놓는다', async () => {
  const harness = setupOutput();
  deliverAt(harness, 2000, { text: '재생할 해설', eventVideoTimeMs: 1000 });
  deliverAt(harness, 2000, { text: '꺼진 분류 해설', eventVideoTimeMs: 1000, narrationClass: 'speaker_identity', source: 'speaker_identity' });
  await harness.clock.runUntil({ isDone: () => harness.outputGlue.getAdPlayList().length === 1 && harness.outputGlue.getDropRecordList().length === 1 });
  const [played, dropped] = harness.outputGlue.getCaptionRecordList();
  assert.equal(played.wavBytes, harness.fakeTts.wavByText.get('재생할 해설'), 'TTS 응답 버퍼를 그대로 참조한다');
  assert.equal(dropped.wavBytes, null);
  assert.deepEqual([dropped.hasAudio, dropped.audioDurationMs], [true, 1500]);
  assert.equal(harness.outputGlue.getDropRecordList()[0].reason, 'feature_off');
});

test('배수 상한으로 멈춘 뒤 늦게 온 캡션은 틈 추론(Bedrock)을 부르지 않고 트리거 자리 기준으로 버린다(제품은 정지 때 지연 버퍼를 비운다)', async () => {
  const harness = setupOutput({ mediaDurationMs: 20000, handlerMap: { 'pipeline-gap': async () => ({ isOk: true, gapIndex: 0, source: 'bedrock', reason: '문장 끝' }) } });
  harness.ctx.core.gapCandidateStore.add({ videoTimeMs: 12500, kind: 'complete', silenceMs: 400, text: '매출이 늘었습니다.' });
  await harness.clock.runUntil({ isDone: () => harness.clock.elapsedMs() >= 16000 });
  harness.outputGlue.noteSessionEnd({ isDrainTimedOut: true });
  harness.chain.stop();
  deliverNow(harness, { text: '늦게 온 해설', eventVideoTimeMs: 12000 });
  await harness.clock.runUntil({ isDone: () => harness.outputGlue.getDropRecordList().length === 1, deadlineElapsedMs: harness.clock.elapsedMs() + 5000 });
  assert.equal(harness.bridge.invokeList.some((call) => call.channel === 'pipeline-gap'), false);
  assert.deepEqual(listDrop(harness), [['늦게 온 해설', 'stopped', 'drain_timeout']]);
  const [record] = harness.outputGlue.getCaptionRecordList();
  assert.equal(record.insertVideoTimeMs, 12000);
  assert.equal(record.gap, null);
  assert.deepEqual(harness.warnList, []);
});

test('연결 코드가 삼킨 비동기 작업 오류는 경고와 함께 이름별로 센다', async () => {
  const harness = setupOutput();
  assert.deepEqual(harness.ctx.getSwallowedErrorCountMap(), {});
  harness.ctx.core.gapCandidateStore.getCandidateList = () => { throw new Error('후보 표 손상'); };
  deliverAt(harness, 16000, { text: '발행 실패 해설', eventVideoTimeMs: 12000 });
  deliverAt(harness, 17000, { text: '또 발행 실패 해설', eventVideoTimeMs: 13000 });
  await harness.clock.runUntil({ isDone: () => harness.clock.elapsedMs() >= 17000 && harness.ctx.getTaskCount() === 0 });
  assert.deepEqual(harness.ctx.getSwallowedErrorCountMap(), { caption: 2 });
  assert.equal(harness.warnList.length, 2);
});

// 공장 resolveInsertionTimeMs 는 ASR 후보 저장소를 바로 읽고 고른 자리를 그대로 쓴다. 제품 main.js 의 collectInsertionGapList·
// snapInsertionToSilence 가 틈 후보 출처 asr 에서 그와 같다는 것(후보 목록·목표 자리를 그대로 돌려줌)을 제품 함수로 묶는다.
test('틈 후보 출처 asr 면 제품의 틈 후보 고르기·넣기 직전 맞추기가 ASR 후보·목표 자리를 그대로 돌려준다(공장이 옮기지 않아도 같다)', () => {
  assert.equal(isAudioGapActive({ gapSource: GAP_CANDIDATE_SOURCE_MAP.asr, hasDelayBuffer: true, delayMs: 10000 }), false);
  assert.equal(isAudioGapActive({ gapSource: GAP_CANDIDATE_SOURCE_MAP.audio, hasDelayBuffer: true, delayMs: 10000 }), true, 'audio 는 균형 모드에서 켜진다(공장 미지원)');
  const asrList = [{ videoTimeMs: 4200, kind: 'complete', silenceMs: 800, offsetMs: -1000 }];
  const spanList = [{ startMs: 5000, endMs: 6000 }];
  assert.equal(buildInsertionGapList({
    isActive: false, asrList, spanList, segmentList: [], isTranscribedAt: () => true, isMeasuredAt: () => true,
    triggerVideoTimeMs: 5200, fromVideoTimeMs: 0, toVideoTimeMs: 10000,
  }), asrList);
  assert.deepEqual(resolveInsertionTargetMs({ isActive: false, targetMs: 5200, playheadMs: 3000, liveMs: 13000, spanList }), { insertMs: 5200, reason: null });
});
