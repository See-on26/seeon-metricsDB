import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAsrGlue } from '../src/session/asr-glue.mjs';
import { createDeixisGlue } from '../src/session/deixis-glue.mjs';
import { createSilenceGlue } from '../src/session/silence-glue.mjs';
import { buildFeatureToggleStore, EVAL_PRESET_MAP } from '../src/session/feature-preset.mjs';
import { FEATURE_KEY_MAP, NARRATION_CLASS_MAP, listDisabledNarrationClass } from '../src/product/core-modules.mjs';
import { createTestContext, levelListFrom } from './helpers/session-fakes.mjs';
import { createRequire } from 'node:module';
import { resolveProductPath } from '../src/product/product-paths.mjs';

const { resolveNarrationEventVideoTimeMs } = createRequire(import.meta.url)(resolveProductPath('src/main/caption-pipeline/router/unified-router.js'));

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
// 연결 코드가 후보마다 붙이는 그 말을 끝낸 영상 시각(제품 attachCandidateEventVideoTime). main 은 해설이 다루는 구 가운데 가장 늦은 이 시각에 해설을 둔다.
const timed = (candidate, eventVideoTimeMs) => ({ ...candidate, eventVideoTimeMs });

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
  // 후보 구가 든 세그먼트 끝(조각 시작 3000 + 2.4초). 가상 벽시계로 바꿔야 이 값이 된다(실제 Date.now 로 바꾸면 수십만 초 어긋난다).
  assert.deepEqual(call.payload.triggerCandidateList, [timed(GRAPH_CANDIDATE, 3000 + 2400)]);
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
  const deixisCallList = harness.bridge.invokeList.filter((item) => item.channel === 'pipeline-deixis');
  const { payload } = deixisCallList[0];
  assert.equal(payload.utterance, '그래서 다음 자료로 이 그래프를 보시면 매출이 늘었습니다.');
  assert.equal(payload.afterTranscript, '매출이 늘었습니다.');
  assert.equal(payload.beforeTranscript, '그래서 다음 자료로 이 그래프를 보시면');
  // 세그먼트가 없으면 후보 시각은 그 조각 끝이다.
  assert.deepEqual(payload.triggerCandidateList, [timed(GRAPH_CANDIDATE, 6000), timed(RISE_CANDIDATE, 9000)], 'lookahead 중 온 뒤 조각의 후보도 같은 판단에 합친다');
  await harness.clock.runUntil({ isDone: () => false, deadlineElapsedMs: 30000 });
  assert.equal(harness.bridge.invokeList.filter((item) => item.channel === 'pipeline-deixis').length, 1, '합친 조각으로 새 판단을 따로 만들지 않는다');
  assert.deepEqual(harness.warnList, []);
});

const PLAIN_SEGMENT = { segmentList: [] };
const findDebug = (harness, reason) => harness.bridge.sendList.filter(({ channel, payload }) => channel === 'pipeline-debug' && payload.reason === reason);

test('판정 뒤 균형 보류(2.5초) 중에 온 뒤 조각의 후보는 같은 결정에 합쳐, 판정 때 뜬 화면과 함께 보류가 끝날 때 한 번에 보낸다', async () => {
  const harness = setupDetection();
  deliverAt(harness, 6800, { text: '이 그래프를 보시면', startMs: 3000, endMs: 6000, ...PLAIN_SEGMENT, triggerCandidateList: [GRAPH_CANDIDATE] });
  deliverAt(harness, 9200, { text: '상반기에는 비슷하다가', startMs: 6000, endMs: 9000, ...PLAIN_SEGMENT });
  // lookahead 는 9300ms 에 끝나 판정이 나고, 보류는 11800ms 까지다. 그 사이에 후보가 실린 뒤 조각이 온다.
  deliverAt(harness, 11000, { text: '하반기에 크게 늘었습니다.', startMs: 9000, endMs: 10500, ...PLAIN_SEGMENT, triggerCandidateList: [RISE_CANDIDATE] });
  await harness.clock.runUntil({ isDone: () => false, deadlineElapsedMs: 30000 });
  const deixisCallList = harness.bridge.invokeList.filter((item) => item.channel === 'pipeline-deixis');
  assert.equal(deixisCallList.length, 1, '보류 중 후보로 새 판단을 따로 만들지 않는다');
  assert.equal(deixisCallList[0].atElapsedMs, 6800 + 2500 + 2500);
  assert.deepEqual(harness.captureList, [{ videoTimeMs: 6800 + 2500, normRect: null }], '화면은 판정이 난 때 한 번만 뜬다');
  const { payload } = deixisCallList[0];
  assert.equal(payload.utterance, '이 그래프를 보시면 상반기에는 비슷하다가 하반기에 크게 늘었습니다.');
  assert.deepEqual(payload.triggerCandidateList, [timed(GRAPH_CANDIDATE, 6000), timed(RISE_CANDIDATE, 10500)], '합친 뒤 조각의 후보는 제 말 끝 시각을 가진다');
  assert.equal(payload.eventVideoTimeMs, 6000, '해설 자리는 첫 후보 시각 그대로다');
  const [joinDebug] = findDebug(harness, '조각을 문장 단위로 이어 붙임');
  assert.match(joinDebug.payload.detail, /판단 전 보류 중 합친 뒤 조각 1개\)$/);
  assert.deepEqual(harness.warnList, []);
});

test('보류가 끝난 뒤 온 후보는 앞 판정과 4초 안이어도 버리지 않고 새로 판단한다', async () => {
  const harness = setupDetection();
  deliverAt(harness, 6800, { text: '이 그래프를 보시면', startMs: 3000, endMs: 6000, ...PLAIN_SEGMENT, triggerCandidateList: [GRAPH_CANDIDATE] });
  // 앞 후보 조각 끝(6000ms)과 3.5초 차이지만 ASR 이 늦게 와 보류(11800ms)가 끝난 뒤 도착한다.
  deliverAt(harness, 12000, { text: '매출이 늘었습니다.', startMs: 6500, endMs: 9500, ...PLAIN_SEGMENT, triggerCandidateList: [RISE_CANDIDATE] });
  await harness.clock.runUntil({ isDone: () => false, deadlineElapsedMs: 30000 });
  const deixisCallList = harness.bridge.invokeList.filter((item) => item.channel === 'pipeline-deixis');
  assert.deepEqual(deixisCallList.map((call) => [call.atElapsedMs, call.payload.triggerCandidateList]), [
    [6800 + 2500 + 2500, [timed(GRAPH_CANDIDATE, 6000)]],
    [12000 + 2500 + 2500, [timed(RISE_CANDIDATE, 9500)]],
  ]);
  assert.deepEqual(harness.warnList, []);
});

test('보류 중에 세션을 멈춰 후보 스케줄러를 비우면 그 결정은 보내지 않고 작업도 남기지 않는다', async () => {
  const harness = setupDetection();
  deliverAt(harness, 6800, { text: '이 그래프를 보시면', startMs: 3000, endMs: 6000, ...PLAIN_SEGMENT, triggerCandidateList: [GRAPH_CANDIDATE] });
  harness.clock.setTimeout(() => {
    harness.ctx.state.isSessionActive = false;
    harness.ctx.core.candidateScheduler.reset();
  }, 10000);
  await harness.clock.runUntil({ isDone: () => false, deadlineElapsedMs: 30000 });
  assert.equal(harness.captureList.length, 1, '판정 때 화면은 떴다');
  assert.equal(harness.bridge.invokeList.some((call) => call.channel === 'pipeline-deixis'), false);
  assert.equal(harness.ctx.getTaskCount(), 0);
  assert.deepEqual(harness.warnList, []);
});

test('후보 시각은 글자 위치로 고른 세그먼트 끝을 가상 시계로 바꾼 영상 시각이고, 늦게 도착해도 말한 시각을 가리킨다', async () => {
  const harness = setupDetection();
  // 같은 조각에 세그먼트 두 개. "이 그래프" 는 첫 세그먼트(0~1.2초), "늘었습니다" 는 둘째(1.6~2.9초). ASR 이 1.9초 늦게 도착한다.
  const text = '이 그래프를 보시면 매출이 늘었습니다.';
  const segmentList = [{ startSec: 0, endSec: 1.2, text: '이 그래프를 보시면' }, { startSec: 1.6, endSec: 2.9, text: '매출이 늘었습니다.' }];
  const graph = { ...GRAPH_CANDIDATE, start: 0, end: 5 };
  const rise = { ...RISE_CANDIDATE, start: text.indexOf('늘었습니다'), end: text.indexOf('늘었습니다') + 5 };
  deliverAt(harness, 7900, { text, startMs: 3000, endMs: 6000, segmentList, triggerCandidateList: [graph, rise] });
  await harness.clock.runUntil({ isDone: () => harness.bridge.invokeList.some((call) => call.channel === 'pipeline-deixis') });
  const { payload } = harness.bridge.invokeList.find((item) => item.channel === 'pipeline-deixis');
  assert.deepEqual(payload.triggerCandidateList.map((candidate) => [candidate.phrase, candidate.eventVideoTimeMs]), [['이 그래프', 4200], ['늘었습니다', 5900]]);
  assert.equal(payload.eventVideoTimeMs, 4200, '결정 시각은 여전히 첫 후보 구가 든 세그먼트 끝');
  // main 은 판단 결과(후보 + isGap)에서 해설이 다루는 구의 eventVideoTimeMs 를 읽는다. 연결 코드가 붙인 이름·값 그대로 해설 자리가 옮겨지는지 본다.
  const judgeList = payload.triggerCandidateList.map((candidate) => ({ ...candidate, isGap: true }));
  assert.equal(resolveNarrationEventVideoTimeMs({
    judgeList, selectedCandidate: { anchor: '이 그래프', mergedAnchorList: ['늘었습니다'] }, fallbackMs: payload.eventVideoTimeMs,
  }), 5900, '해설이 다루는 구 가운데 가장 늦게 말한 시각');
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
  // 무발화 해설은 반응 묘사 범위가 아니라 무발화 전용 범위(5~14어절)를 균형 모드 시간으로 줄인 예산이다.
  assert.deepEqual(call.payload.wordBudget, { minWordCount: 5, maxWordCount: 13, isDroppable: false });
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
