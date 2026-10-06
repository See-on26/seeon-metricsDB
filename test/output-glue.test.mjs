import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlaybackRecorder } from '../src/session/playback-recorder.mjs';
import { startPlaybackChain } from '../src/session/playback-chain.mjs';
import { createOutputGlue } from '../src/session/output-glue.mjs';
import { createTestContext } from './helpers/session-fakes.mjs';
import { createToneWav } from './helpers/mock-services.mjs';

function setupOutput({ handlerMap = {}, mediaDurationMs = 60000, isPageTransitionIncluded = false } = {}) {
  const harness = createTestContext({ mediaDurationMs, handlerMap, isPageTransitionIncluded });
  const recorder = createPlaybackRecorder();
  const outputGlue = createOutputGlue({ ctx: harness.ctx });
  const chain = startPlaybackChain({ ctx: harness.ctx, recorder, onAdStart: outputGlue.noteAdStart, onNarrationDrop: outputGlue.handleNarrationDrop });
  return { ...harness, recorder, outputGlue, chain };
}

let nextTs = 1;
function buildCaption({ text, eventVideoTimeMs, narrationClass = 'deixis', source = 'deixis', durationMs = 1500, hasWav = true, slideLabel = null }) {
  nextTs += 1;
  return {
    type: 'caption', ts: 1_800_000_000_000 + nextTs, text, source, slideLabel, narrationClass, eventVideoTimeMs,
    wavData: hasWav ? createToneWav({ durationMs }) : null,
    rationale: { utterance: '이 그래프를 보시면', subKind: null, summary: '근거 표현=이 그래프' },
  };
}
const requestContext = { seq: 9, channel: 'pipeline-deixis', callList: [{ service: 'vlm', modelId: 'qwen', isVlmFallback: false }] };
const deliverAt = (harness, atMs, payload) => harness.clock.setTimeout(() => harness.outputGlue.handleCaptionEvent({ payload, requestContext }), atMs);

test('지시 해설은 틈 후보 중 Bedrock 이 고른 자리에 넣고, 재생헤드가 닿으면 원음을 멈추고 튼다', async () => {
  const harness = setupOutput({ handlerMap: { 'pipeline-gap': async () => ({ isOk: true, gapIndex: 0, source: 'bedrock', reason: '문장 끝' }) } });
  harness.ctx.core.gapCandidateStore.add({ videoTimeMs: 12500, kind: 'complete', silenceMs: 400, text: '매출이 늘었습니다.' });
  harness.ctx.core.gapCandidateStore.add({ videoTimeMs: 14000, kind: 'pause', silenceMs: 600, text: '그리고' });
  deliverAt(harness, 16000, buildCaption({ text: '막대 그래프 상승 구간', eventVideoTimeMs: 12000 }));
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
});

test('무발화 해설은 틈을 고르지 않고 감지 시점에 넣는다', async () => {
  const harness = setupOutput();
  deliverAt(harness, 21000, buildCaption({ text: '여행 사진 묘사', eventVideoTimeMs: 20000, narrationClass: 'silence_based', source: 'visual_description' }));
  await harness.clock.runUntil({ isDone: () => harness.outputGlue.getAdPlayList().length === 1 });
  assert.equal(harness.bridge.invokeList.some((call) => call.channel === 'pipeline-gap'), false);
  assert.equal(harness.outputGlue.getCaptionRecordList()[0].insertVideoTimeMs, 20000);
});

test('누적 지연이 6초를 넘으면 캡션을 버리고(main 에 알리지 않음) excess_delay 로 남긴다', async () => {
  const harness = setupOutput();
  deliverAt(harness, 2000, buildCaption({ text: '긴 해설', eventVideoTimeMs: 1000, durationMs: 7500 }));
  deliverAt(harness, 18000, buildCaption({ text: '늦은 해설', eventVideoTimeMs: 17000 }));
  await harness.clock.runUntil({ isDone: () => harness.outputGlue.getDropRecordList().length === 1, deadlineElapsedMs: 30000 });
  const [drop] = harness.outputGlue.getDropRecordList();
  assert.equal(drop.text, '늦은 해설');
  assert.equal(drop.reason, 'excess_delay');
  assert.equal(harness.bridge.sendList.some(({ channel }) => channel === 'pipeline-narration-dropped'), false);
});

test('꺼진 분류(화자 식별)는 대기 줄에서 feature_off 로 버리고 main 에 알린다', async () => {
  const harness = setupOutput();
  deliverAt(harness, 15000, buildCaption({ text: '발표자 홍길동', eventVideoTimeMs: 14000, narrationClass: 'speaker_identity', source: 'speaker_identity' }));
  await harness.clock.runUntil({ isDone: () => harness.outputGlue.getDropRecordList().length === 1 });
  assert.equal(harness.outputGlue.getDropRecordList()[0].reason, 'feature_off');
  const report = harness.bridge.sendList.find(({ channel }) => channel === 'pipeline-narration-dropped');
  assert.equal(report.payload.reason, 'feature_off');
  assert.equal(report.payload.text, '발표자 홍길동');
});

test('TTS 가 실패해 wav 가 없으면 재생하지 않고 no_audio 로 남긴다', async () => {
  const harness = setupOutput();
  deliverAt(harness, 15000, buildCaption({ text: '소리 없는 해설', eventVideoTimeMs: 14000, hasWav: false }));
  await harness.clock.runUntil({ isDone: () => harness.outputGlue.getDropRecordList().length === 1 });
  assert.equal(harness.outputGlue.getDropRecordList()[0].reason, 'no_audio');
  assert.equal(harness.outputGlue.getAdPlayList().length, 0);
});

test('영상 끝 뒤로 잡힌 예약은 after_end 로 버린다', () => {
  const harness = setupOutput({ mediaDurationMs: 20000 });
  harness.outputGlue.handleCaptionEvent({ payload: buildCaption({ text: '끝 뒤 해설', eventVideoTimeMs: 21000, narrationClass: 'silence_based', source: 'visual_description' }), requestContext });
  return harness.clock.runUntil({ isDone: () => harness.ctx.core.narrationScheduler.pendingCount === 1 }).then(() => {
    harness.outputGlue.dropPendingAfterEnd();
    assert.equal(harness.outputGlue.getDropRecordList()[0].reason, 'after_end');
  });
});

const PRODUCT_SOURCE_MARK = '/seeon-meet/src/';
const WATCH_STACK_TRACE_LIMIT = 50;

// 지연 버퍼·대기 줄·체류·지시 후보 타이머를 모두 쓰는 장면. 해설이 끝난 뒤 따라잡기 갈래(caption-narrator.js:210-234)까지 지난다.
async function runWatchedScenario() {
  const harness = setupOutput({ handlerMap: { 'pipeline-gap': async () => ({ isOk: true, gapIndex: 0, source: 'bedrock', reason: '' }) } });
  harness.ctx.core.gapCandidateStore.add({ videoTimeMs: 12500, kind: 'complete', silenceMs: 400, text: '끝.' });
  deliverAt(harness, 16000, buildCaption({ text: '해설', eventVideoTimeMs: 12000 }));
  harness.ctx.core.candidateScheduler.submit({ source: 'speech', utterance: '이것', trigger: '이것', captureTs: harness.clock.nowPerf(), videoTimeMs: 0 });
  harness.ctx.core.slideDwellGate.enter({ label: '1' });
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
  deliverAt(harness, 500, buildCaption({ text: '2번 슬라이드, 매출 추이', eventVideoTimeMs: 400, narrationClass: 'page_transition', source: 'page-transition', slideLabel: '2' }));
  deliverAt(harness, 600, buildCaption({ text: '여행 사진', eventVideoTimeMs: 400, narrationClass: 'page_transition', source: 'visual_description', slideLabel: '2' }));
  harness.clock.setTimeout(() => harness.ctx.core.slideDwellGate.enter({ label: '3' }), 1000);
  await harness.clock.runUntil({ isDone: () => harness.outputGlue.getDropRecordList().length === 2 });
  assert.deepEqual(harness.outputGlue.getDropRecordList().map(({ text, reason }) => [text, reason]), [
    ['2번 슬라이드, 매출 추이', 'dwell_cancelled'], ['여행 사진', 'leader_cancelled'],
  ]);
  assert.ok(debugReasonList(harness).includes('체류 미달 — 재생 전 취소(선판정 후취소)'));
  assert.ok(debugReasonList(harness).includes('전환 고지 취소 — 딸린 사진 묘사도 버림'));
  assert.equal(harness.bridge.invokeList.some((call) => call.channel === 'pipeline-gap'), false);
  assert.equal(harness.outputGlue.getAdPlayList().length, 0);
  assert.deepEqual(harness.warnList, []);
});

test('체류를 채운 전환 고지가 틈을 고르면 딸린 사진 묘사는 그 바로 뒤(+1ms)에 붙어 고지 다음에 재생된다', async () => {
  const harness = setupOutput({ isPageTransitionIncluded: true, handlerMap: { 'pipeline-gap': async () => ({ isOk: true, gapIndex: 0, source: 'bedrock', reason: '전환 뒤 첫 쉼' }) } });
  harness.ctx.core.slideDwellGate.enter({ label: '2' });
  harness.ctx.core.gapCandidateStore.add({ videoTimeMs: 2500, kind: 'complete', silenceMs: 500, text: '넘어가겠습니다.' });
  deliverAt(harness, 3500, buildCaption({ text: '2번 슬라이드, 매출 추이', eventVideoTimeMs: 400, narrationClass: 'page_transition', source: 'page-transition', slideLabel: '2' }));
  deliverAt(harness, 3500, buildCaption({ text: '여행 사진', eventVideoTimeMs: 400, narrationClass: 'page_transition', source: 'visual_description', slideLabel: '2' }));
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

test('틈 추론이 실패하면 트리거 지점에 넣고 실패한 추론 결과를 기록에 남긴다', async () => {
  const harness = setupOutput({ handlerMap: { 'pipeline-gap': async () => { throw new Error('bedrock 끊김'); } } });
  harness.ctx.core.gapCandidateStore.add({ videoTimeMs: 12500, kind: 'complete', silenceMs: 400, text: '매출이 늘었습니다.' });
  deliverAt(harness, 16000, buildCaption({ text: '막대 그래프 상승 구간', eventVideoTimeMs: 12000 }));
  await harness.clock.runUntil({ isDone: () => harness.outputGlue.getAdPlayList().length === 1 });
  const [record] = harness.outputGlue.getCaptionRecordList();
  assert.equal(record.insertVideoTimeMs, 12000);
  assert.deepEqual(record.gap, { source: null, reason: null, gapIndex: null, candidateCount: 1, callList: [] });
  assert.ok(harness.outputGlue.getAdPlayList()[0].playedMediaMs >= 12000 && harness.outputGlue.getAdPlayList()[0].playedMediaMs <= 12200);
  assert.deepEqual(harness.warnList, []);
});

test('배수 뒤 도착한 해설은 after_end 로 버리고, stop 은 재생 사슬의 가상 타이머를 모두 거둔다', async () => {
  const harness = setupOutput({ mediaDurationMs: 20000 });
  deliverAt(harness, 5000, buildCaption({ text: '첫 해설', eventVideoTimeMs: 4000 }));
  await harness.clock.runUntil({ isDone: () => harness.clock.elapsedMs() >= 16000 });
  assert.equal(harness.outputGlue.getAdPlayList().length, 1);
  harness.outputGlue.dropPendingAfterEnd();
  assert.deepEqual(harness.outputGlue.getDropRecordList(), []);
  harness.outputGlue.handleCaptionEvent({ payload: buildCaption({ text: '늦게 온 해설', eventVideoTimeMs: 15000 }), requestContext });
  await harness.clock.runUntil({ isDone: () => harness.outputGlue.getDropRecordList().length === 1, deadlineElapsedMs: harness.clock.elapsedMs() + 5000 });
  assert.deepEqual(harness.outputGlue.getDropRecordList().map(({ text, reason }) => [text, reason]), [['늦게 온 해설', 'after_end']]);
  assert.equal(harness.ctx.core.narrationScheduler.pendingCount, 0);
  harness.recorder.close({ atElapsedMs: harness.clock.elapsedMs(), mediaMs: harness.ctx.core.delayBuffer.getDelayedTimeMs() });
  harness.chain.stop();
  assert.equal(harness.clock.pendingTimerCount, 0);
  const pieceList = harness.recorder.getPieceList();
  assert.equal(pieceList[0].kind, 'source');
  assert.equal(pieceList[0].srcStartMs, 0);
  assert.ok(pieceList[0].srcEndMs >= 4000 && pieceList[0].srcEndMs <= 4200, `첫 원음 끝 ${pieceList[0].srcEndMs}`);
  const adPieceList = pieceList.filter((piece) => piece.kind === 'ad');
  assert.deepEqual(adPieceList.map(({ adRef, outStartMs, outEndMs }) => [adRef, outEndMs - outStartMs]), [[1, 1500]]);
  assert.deepEqual(harness.warnList, []);
});

test('배수 상한에 닿아 멈추면 영상 안 자리의 남은·늦게 온 해설은 drain_timeout, 영상 끝 뒤 자리는 after_end 로 버린다', async () => {
  const harness = setupOutput({ mediaDurationMs: 20000 });
  harness.outputGlue.handleCaptionEvent({ payload: buildCaption({ text: '영상 안 예약', eventVideoTimeMs: 15000 }), requestContext });
  harness.outputGlue.handleCaptionEvent({ payload: buildCaption({ text: '영상 끝 뒤 예약', eventVideoTimeMs: 21000 }), requestContext });
  await harness.clock.runUntil({ isDone: () => harness.ctx.core.narrationScheduler.pendingCount === 2 });
  harness.outputGlue.dropPendingAfterEnd({ isDrainTimedOut: true });
  harness.outputGlue.handleCaptionEvent({ payload: buildCaption({ text: '늦게 온 영상 안 해설', eventVideoTimeMs: 12000 }), requestContext });
  harness.outputGlue.handleCaptionEvent({ payload: buildCaption({ text: '늦게 온 영상 끝 뒤 해설', eventVideoTimeMs: 25000 }), requestContext });
  await harness.clock.runUntil({ isDone: () => harness.outputGlue.getDropRecordList().length === 4, deadlineElapsedMs: harness.clock.elapsedMs() + 5000 });
  assert.deepEqual(harness.outputGlue.getDropRecordList().map(({ text, reason }) => [text, reason]), [
    ['영상 안 예약', 'drain_timeout'], ['영상 끝 뒤 예약', 'after_end'],
    ['늦게 온 영상 안 해설', 'drain_timeout'], ['늦게 온 영상 끝 뒤 해설', 'after_end'],
  ]);
  assert.deepEqual(harness.warnList, []);
});

test('영상 끝 직후 도착한 캡션은 excess_delay 로 버려지지 않고 재생되며, 끝 구간 원음이 1.5배속으로 뛰지 않는다', async () => {
  const harness = setupOutput({ mediaDurationMs: 20000 });
  const { core } = harness.ctx;
  const rateList = [];
  harness.clock.setTimeout(() => core.delaySource.enterTailMode(), 20000);
  const rateProbe = harness.clock.setInterval(() => {
    if (harness.clock.elapsedMs() > 20000 && !harness.outputGlue.getAdPlayList().length) rateList.push(core.delayBuffer.delayedVideo.playbackRate);
  }, 250);
  deliverAt(harness, 20500, buildCaption({ text: '끝 직후 도착한 해설', eventVideoTimeMs: 18000 }));
  await harness.clock.runUntil({ isDone: () => harness.outputGlue.getAdPlayList().length === 1, deadlineElapsedMs: 40000 });
  harness.clock.clearInterval(rateProbe);
  assert.deepEqual(harness.outputGlue.getDropRecordList(), []);
  const [adPlay] = harness.outputGlue.getAdPlayList();
  assert.ok(adPlay.playedMediaMs >= 18000 && adPlay.playedMediaMs <= 18200, `재생 위치 ${adPlay.playedMediaMs}`);
  assert.ok(rateList.length > 20, `표본 ${rateList.length}개`);
  assert.equal(Math.max(...rateList), 1);
  assert.deepEqual(harness.warnList, []);
});

test('지연 재생 요소가 끝난 지 6초 넘어 도착한 끝 구간 캡션도 excess_delay 로 버리지 않고 끝 자리에 재생한다', async () => {
  const harness = setupOutput({ mediaDurationMs: 20000 });
  const { core } = harness.ctx;
  harness.clock.setTimeout(() => core.delaySource.enterTailMode(), 20000);
  deliverAt(harness, 37000, buildCaption({ text: '끝 구간 늦은 해설', eventVideoTimeMs: 19000 }));
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

test('캡션 발행 중 오류가 나면 재생도 드롭도 아닌 채 남기지 않고 emit_failed 로 남긴다', async () => {
  const harness = setupOutput();
  harness.ctx.core.gapCandidateStore.getCandidateList = () => { throw new Error('후보 표 손상'); };
  deliverAt(harness, 16000, buildCaption({ text: '발행 실패 해설', eventVideoTimeMs: 12000 }));
  await harness.clock.runUntil({ isDone: () => harness.clock.elapsedMs() >= 16000 && harness.ctx.getTaskCount() === 0 });
  assert.deepEqual(harness.outputGlue.getDropRecordList().map(({ text, reason }) => [text, reason]), [['발행 실패 해설', 'emit_failed']]);
  assert.deepEqual(harness.warnList, ['[factory] caption 실패(무시): 후보 표 손상']);
});

test('재생한 캡션은 wav 를 복사 없이 참조로 두고, 버린 캡션은 wav 를 놓는다', async () => {
  const harness = setupOutput();
  const playedPayload = buildCaption({ text: '재생할 해설', eventVideoTimeMs: 1000 });
  const offPayload = buildCaption({ text: '꺼진 분류 해설', eventVideoTimeMs: 1000, narrationClass: 'speaker_identity', source: 'speaker_identity' });
  deliverAt(harness, 2000, playedPayload);
  deliverAt(harness, 2000, offPayload);
  await harness.clock.runUntil({ isDone: () => harness.outputGlue.getAdPlayList().length === 1 && harness.outputGlue.getDropRecordList().length === 1 });
  const [played, dropped] = harness.outputGlue.getCaptionRecordList();
  assert.equal(played.wavBytes, playedPayload.wavData);
  assert.equal(dropped.wavBytes, null);
  assert.deepEqual([dropped.hasAudio, dropped.audioDurationMs], [true, 1500]);
  assert.equal(harness.outputGlue.getDropRecordList()[0].reason, 'feature_off');
});
