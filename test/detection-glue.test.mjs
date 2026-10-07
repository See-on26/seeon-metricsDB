import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAsrGlue } from '../src/session/asr-glue.mjs';
import { createDeixisGlue } from '../src/session/deixis-glue.mjs';
import { createSilenceGlue } from '../src/session/silence-glue.mjs';
import { buildFeatureToggleStore, EVAL_PRESET_MAP } from '../src/session/feature-preset.mjs';
import { FEATURE_KEY_MAP, NARRATION_CLASS_MAP, listDisabledNarrationClass } from '../src/product/core-modules.mjs';
import { createTestContext, levelListFrom } from './helpers/session-fakes.mjs';

function setupDetection(options = {}) {
  const harness = createTestContext(options);
  const asrGlue = createAsrGlue({ ctx: harness.ctx, segmentList: [], segmentBufferMap: new Map() });
  createDeixisGlue({ ctx: harness.ctx });
  return { ...harness, asrGlue };
}

// 전사는 조각 녹음이 끝난 뒤(endMs ≤ atMs)에 도착한다. 제품의 endTs 도 늘 도착 시각보다 앞선다.
// 트리거 후보는 main 이 asr 이벤트에 실어 보내는 모양({ type, phrase, start, end }) 그대로 준다.
const deliverAt = ({ clock, asrGlue, ctx }, atMs, { text, startMs, endMs, segmentList, triggerCandidateList }) => clock.setTimeout(
  () => asrGlue.handleAsrTranscript({ text, ts: ctx.toWallTs(startMs), endTs: ctx.toWallTs(endMs), segmentList, triggerCandidateList }), atMs);
const GRAPH_CANDIDATE = { type: 'demonstrative', phrase: '이 그래프', start: 0, end: 5 };
const RISE_CANDIDATE = { type: 'change', phrase: '늘었습니다', start: 0, end: 5 };

test('평가 프리셋은 페이지 전환·화자·요약을 끄고, 페이지 전환 포함이면 페이지 전환만 켠다', () => {
  assert.deepEqual(EVAL_PRESET_MAP, { page_transition: false, speaker_identity: false, meeting_summary: false });
  const evalStore = buildFeatureToggleStore();
  assert.deepEqual(Object.values(FEATURE_KEY_MAP).map((key) => evalStore.isOn(key)), [false, false, false]);
  assert.deepEqual(listDisabledNarrationClass({ store: evalStore }), [NARRATION_CLASS_MAP.pageTransition, NARRATION_CLASS_MAP.speakerIdentity]);
  const transitionStore = buildFeatureToggleStore({ isPageTransitionIncluded: true });
  assert.equal(transitionStore.isOn(FEATURE_KEY_MAP.pageTransition), true);
  assert.deepEqual(listDisabledNarrationClass({ store: transitionStore }), [NARRATION_CLASS_MAP.speakerIdentity]);
});

test('음성 조각만, 녹음이 끝난 영상 시각에 벽시계 시작·끝을 붙여 pipeline-audio 로 보낸다', async () => {
  const segmentList = [
    { startMs: 0, endMs: 3000, voicedMs: 2000, isVoiced: true },
    { startMs: 3000, endMs: 5600, voicedMs: 100, isVoiced: false },
    { startMs: 5600, endMs: 8600, voicedMs: 2500, isVoiced: true },
  ];
  const segmentBufferMap = new Map([[0, Buffer.from('first')], [5600, Buffer.from('second')]]);
  const harness = createTestContext();
  const asrGlue = createAsrGlue({ ctx: harness.ctx, segmentList, segmentBufferMap });
  asrGlue.start();
  await harness.clock.runUntil({ isDone: () => harness.bridge.invokeList.length >= 2 });
  const { ctx, bridge } = harness;
  assert.deepEqual(bridge.invokeList.map(({ channel, atElapsedMs, payload }) => [channel, atElapsedMs, payload.startTs, payload.endTs]), [
    ['pipeline-audio', 3000, ctx.toWallTs(0), ctx.toWallTs(3000)],
    ['pipeline-audio', 8600, ctx.toWallTs(5600), ctx.toWallTs(8600)],
  ]);
  assert.ok(bridge.invokeList.every(({ atElapsedMs, payload }) => payload.endTs <= ctx.toWallTs(atElapsedMs)), 'endTs 는 보내는 순간보다 미래가 아니다');
  assert.equal(Buffer.from(bridge.invokeList[1].payload.buffer).toString(), 'second');
  assert.equal(bridge.invokeList[0].payload.speakerHint, null);
  assert.equal(bridge.invokeList[0].payload.isSpeakerTracked, false, '평가 프리셋은 화자 식별을 꺼 회의 스크립트에 화자를 적지 않는다');
  assert.equal(harness.clock.pendingTimerCount, 0, '마지막 조각 뒤에는 타이머를 남기지 않는다');
  assert.deepEqual(harness.warnList, []);
});

test('트리거 후보가 실린 조각이 오면 lookahead 2.5초 뒤 판정, 그때 프레임을 뜨고 균형 보류 2.5초 뒤 후보와 함께 pipeline-deixis 를 보낸다', async () => {
  const harness = setupDetection();
  const text = '이 그래프를 보시면 매출이 늘었습니다.';
  deliverAt(harness, 6800, { text, startMs: 3000, endMs: 6000, segmentList: [{ startSec: 0, endSec: 2.4, text }], triggerCandidateList: [GRAPH_CANDIDATE] });
  await harness.clock.runUntil({ isDone: () => harness.bridge.invokeList.some((call) => call.channel === 'pipeline-deixis') });
  const call = harness.bridge.invokeList.find((item) => item.channel === 'pipeline-deixis');
  assert.equal(call.atElapsedMs, 6800 + 2500 + 2500);
  assert.deepEqual(harness.captureList, [{ videoTimeMs: 6800 + 2500, normRect: null }]);
  assert.equal(call.payload.utterance, text);
  assert.equal(call.payload.eventVideoTimeMs, 3000 + 2400, '트리거 세그먼트 끝 = 조각 시작 + endSec');
  assert.equal(call.payload.hasPointingRegion, false);
  assert.equal(call.payload.slideLabel, null);
  assert.deepEqual(Object.keys(call.payload.wordBudgetMap).sort(), ['deixis', 'interpretation', 'visual_description']);
  assert.equal(call.payload.wordBudgetMap.deixis.isDroppable, false);
  assert.equal(call.payload.ts, harness.ctx.toWallTs(6800 + 5000));
  assert.deepEqual(call.payload.triggerCandidateList, [GRAPH_CANDIDATE]);
  assert.ok(harness.bridge.sendList.some(({ payload }) => payload.reason === '발화 지시가 트리거' && payload.detail === '근거="이 그래프"'),
    '화면 의존성 근거는 후보 구에서 읽는다');
  assert.deepEqual(harness.warnList, []);
});

test('앞의 끝나지 않은 조각은 lead 로, lookahead 중 온 조각은 follow 로 붙고 뒤 맥락(7초 창)에도 들어간다', async () => {
  const harness = setupDetection();
  deliverAt(harness, 4000, { text: '그래서 다음 자료로', startMs: 0, endMs: 3000, segmentList: [] });
  deliverAt(harness, 6800, { text: '이 그래프를 보시면', startMs: 3000, endMs: 6000, segmentList: [], triggerCandidateList: [GRAPH_CANDIDATE] });
  deliverAt(harness, 9200, { text: '매출이 늘었습니다.', startMs: 6000, endMs: 9000, segmentList: [], triggerCandidateList: [RISE_CANDIDATE] });
  await harness.clock.runUntil({ isDone: () => harness.bridge.invokeList.some((call) => call.channel === 'pipeline-deixis') });
  const { payload } = harness.bridge.invokeList.find((item) => item.channel === 'pipeline-deixis');
  assert.equal(payload.utterance, '그래서 다음 자료로 이 그래프를 보시면 매출이 늘었습니다.');
  assert.equal(payload.afterTranscript, '매출이 늘었습니다.');
  assert.equal(payload.beforeTranscript, '그래서 다음 자료로 이 그래프를 보시면');
  assert.deepEqual(payload.triggerCandidateList, [GRAPH_CANDIDATE], '뒤 조각은 앞 후보의 문장으로만 붙고, 그 조각의 후보는 새 판단에 넣지 않는다(판정이 났거나 4초 쿨다운 안)');
  assert.deepEqual(harness.warnList, []);
});

test('트리거 후보가 없는 조각은 지시 후보가 되지 않는다(지시 판단은 main 트리거가 정한다)', async () => {
  const harness = setupDetection();
  deliverAt(harness, 6800, { text: '이 그래프를 보시면 매출이 늘었습니다.', startMs: 3000, endMs: 6000, segmentList: [] });
  await harness.clock.runUntil({ isDone: () => false, deadlineElapsedMs: 20000 });
  assert.equal(harness.bridge.invokeList.some((call) => call.channel === 'pipeline-deixis'), false);
  assert.equal(harness.ctx.core.candidateScheduler.pending, null);
  assert.deepEqual(harness.warnList, []);
});

test('lookahead 동안 들어온 다른 조각의 트리거 후보는 같은 판단에 합쳐 보내고, 같은 유형·구는 한 번만 넣는다', async () => {
  const harness = setupDetection();
  const tableCandidate = { type: 'demonstrative', phrase: '이 표', start: 0, end: 3 };
  harness.clock.setTimeout(() => harness.ctx.hooks.onDeixis({
    text: '이 그래프를 보시면', trigger: '이 그래프', candidateList: [GRAPH_CANDIDATE], captureTs: harness.ctx.toWallTs(6000), eventWallTs: null,
  }), 6800);
  harness.clock.setTimeout(() => harness.ctx.hooks.onDeixis({
    text: '이 표와 이 그래프', trigger: '이 표, 이 그래프', candidateList: [tableCandidate, GRAPH_CANDIDATE], captureTs: harness.ctx.toWallTs(8000), eventWallTs: null,
  }), 8200);
  await harness.clock.runUntil({ isDone: () => harness.bridge.invokeList.some((call) => call.channel === 'pipeline-deixis') });
  const { payload } = harness.bridge.invokeList.find((item) => item.channel === 'pipeline-deixis');
  assert.deepEqual(payload.triggerCandidateList, [GRAPH_CANDIDATE, tableCandidate]);
  assert.deepEqual(harness.warnList, []);
});

test('틈 후보는 세그먼트 끝 벽시계를 영상 시각으로 바꿔 쌓는다', async () => {
  const harness = setupDetection();
  deliverAt(harness, 6800, {
    text: '다음은 보상 구조입니다. 빨간 막대들을', startMs: 3000, endMs: 6000,
    segmentList: [{ startSec: 0, endSec: 1.2, text: '다음은 보상 구조입니다.' }, { startSec: 1.6, endSec: 2.9, text: '빨간 막대들을' }],
  });
  await harness.clock.runUntil({ isDone: () => harness.ctx.core.gapCandidateStore.size > 0 });
  const gapList = harness.ctx.core.gapCandidateStore.getCandidateList({ triggerVideoTimeMs: 4000, fromVideoTimeMs: 0, toVideoTimeMs: 10000 });
  assert.deepEqual(gapList.map((gap) => [gap.videoTimeMs, gap.kind]), [[4200, 'complete']]);
  assert.deepEqual(harness.warnList, []);
});

test('말소리가 끊기고 5초가 지나면 직전 15초 전사·슬라이드와 함께 pipeline-silence 를 보낸다', async () => {
  const harness = setupDetection({ levelList: levelListFrom([[2000, 0.1], [20000, 0]]) });
  const silenceGlue = createSilenceGlue({ ctx: harness.ctx });
  harness.ctx.core.slideRegistry.handleCandidate({ embedding: [1, 0, 0] });
  harness.ctx.core.transcriptWindow.push({ text: '이 사진들을 한번 보시죠.', ts: harness.clock.nowPerf() });
  silenceGlue.start();
  await harness.clock.runUntil({ isDone: () => harness.bridge.invokeList.some((call) => call.channel === 'pipeline-silence') });
  const call = harness.bridge.invokeList.find((item) => item.channel === 'pipeline-silence');
  assert.equal(call.atElapsedMs, 7000);
  assert.equal(call.payload.silenceMs, 5000);
  assert.equal(call.payload.slideLabel, '1');
  assert.equal(call.payload.recentTranscript, '이 사진들을 한번 보시죠.');
  assert.equal(call.payload.eventVideoTimeMs, 7000);
  assert.equal(call.payload.wordBudget.isDroppable, false);
  silenceGlue.stop();
  assert.equal(harness.clock.pendingTimerCount, 0, 'stop 은 100ms tick 을 멈춘다');
  assert.deepEqual(harness.warnList, []);
});

test('해설 재생(삽입) 중과 그 뒤 500ms 는 말이 이어진 것으로 보고, 그 뒤부터 무음을 센다', async () => {
  const harness = setupDetection({ levelList: levelListFrom([[2000, 0.1], [20000, 0]]) });
  harness.ctx.core.narrator = { getSicState: () => ({ isInserting: harness.ctx.videoTimeMs() <= 4000 }) };
  const silenceGlue = createSilenceGlue({ ctx: harness.ctx });
  harness.ctx.core.slideRegistry.handleCandidate({ embedding: [1, 0, 0] });
  harness.ctx.core.transcriptWindow.push({ text: '이 사진들을 한번 보시죠.', ts: harness.clock.nowPerf() });
  silenceGlue.start();
  await harness.clock.runUntil({ isDone: () => harness.bridge.invokeList.some((call) => call.channel === 'pipeline-silence') });
  const call = harness.bridge.invokeList.find((item) => item.channel === 'pipeline-silence');
  assert.equal(call.atElapsedMs, 9400, '마지막 가림 tick 4400 + 5000');
  assert.deepEqual(harness.warnList, []);
});

test('슬라이드가 없으면 침묵 해설을 보내지 않는다(공유 화면 없음)', async () => {
  const harness = setupDetection({ levelList: levelListFrom([[1000, 0.1], [9000, 0]]) });
  const silenceGlue = createSilenceGlue({ ctx: harness.ctx });
  harness.ctx.core.transcriptWindow.push({ text: '보시죠.', ts: harness.clock.nowPerf() });
  silenceGlue.start();
  await harness.clock.runUntil({ isDone: () => false, deadlineElapsedMs: 9000 });
  assert.equal(harness.bridge.invokeList.some((call) => call.channel === 'pipeline-silence'), false);
  assert.ok(harness.bridge.sendList.some(({ payload }) => payload.reason === '공유 화면 없음'));
  assert.deepEqual(harness.warnList, []);
});
