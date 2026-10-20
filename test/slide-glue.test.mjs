import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSlideGlue } from '../src/session/slide-glue.mjs';
import { createTestContext } from './helpers/session-fakes.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const WIDTH = 480;
const HEIGHT = 270;
function solidFrame([r, g, b], box = null) {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = (y * WIDTH + x) * 4;
      const isBox = box && x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
      data[offset] = isBox ? 255 : r; data[offset + 1] = isBox ? 255 : g; data[offset + 2] = isBox ? 255 : b; data[offset + 3] = 255;
    }
  }
  return { data, width: WIDTH, height: HEIGHT };
}
const RED = solidFrame([200, 30, 30]);
const BLUE = solidFrame([30, 30, 200]);
const LOCAL_EMBEDDING_WARNING = '[slide] GPU 임베딩 서버 미연결 — 로컬 그리드 임베딩으로 폴백(정확도 낮음, 고지는 유지)';

function setupSlides({ frameAt, embedHandler }) {
  const harness = createTestContext({
    handlerMap: { 'embed-frame': embedHandler ?? (async () => ({ isOk: true, embedding: [1, 0, 0] })) },
  });
  const slideFrameDir = makeTempDir('factory-slides-');
  const slideGlue = createSlideGlue({ ctx: harness.ctx, readFrameAt: async (timeMs) => frameAt(timeMs), slideFrameDir });
  return { ...harness, slideGlue, slideFrameDir };
}

const callsOf = (bridge, channel) => bridge.invokeList.filter((call) => call.channel === channel);
const sendsOf = (bridge, channel) => bridge.sendList.filter((call) => call.channel === channel);

test('첫 샘플 → embed-frame → 새 슬라이드 1 → 슬라이드 글자 전사 → 체류 3초 → pipeline-frame(사건 시각 = 확정 시각)', async () => {
  const harness = setupSlides({ frameAt: () => RED });
  harness.slideGlue.start();
  await harness.clock.runUntil({ isDone: () => callsOf(harness.bridge, 'pipeline-frame').length > 0 && harness.bridge.sendList.some(({ channel }) => channel === 'pipeline-slide-mark') });
  assert.equal(callsOf(harness.bridge, 'embed-frame')[0].atElapsedMs, 400);
  assert.deepEqual(callsOf(harness.bridge, 'pipeline-slide-text').map((call) => call.payload.slideLabel), ['1']);
  const frameCall = callsOf(harness.bridge, 'pipeline-frame')[0];
  assert.equal(frameCall.atElapsedMs, 3400);
  assert.equal(frameCall.payload.slideLabel, '1');
  assert.equal(frameCall.payload.eventVideoTimeMs, 400);
  assert.equal(frameCall.payload.isRevisit, false);
  assert.deepEqual([frameCall.payload.wordBudget.minWordCount, frameCall.payload.wordBudget.maxWordCount], [6, 9]);
  assert.equal(harness.ctx.core.slideRegistry.currentLabel(), '1');
  const mark = harness.bridge.sendList.find(({ channel }) => channel === 'pipeline-slide-mark');
  assert.equal(mark.payload.frameKind, 'base');
  assert.ok(fs.existsSync(mark.payload.filePath));
  assert.equal(mark.payload.transitionTs, harness.ctx.toWallTs(400), '전환 시각은 체류 확정이 아니라 슬라이드 확정 시각');
  assert.ok(mark.payload.ts <= harness.clock.nowWall(), '렌더러 시각은 가상 시계보다 미래가 아니다');
  assert.deepEqual(harness.warnList, []);
});

test('체류 3초 전에 다른 슬라이드로 넘어가면 앞 슬라이드 고지는 취소되고 뒤 슬라이드만 생성한다', async () => {
  const harness = setupSlides({
    frameAt: (timeMs) => (timeMs < 2000 ? RED : BLUE),
    embedHandler: async () => ({ isOk: true, embedding: harness.ctx.videoTimeMs() < 2000 ? [1, 0, 0] : [0, 1, 0] }),
  });
  harness.slideGlue.start();
  await harness.clock.runUntil({ isDone: () => callsOf(harness.bridge, 'pipeline-frame').length > 0 });
  const frameCallList = callsOf(harness.bridge, 'pipeline-frame');
  assert.deepEqual(frameCallList.map((call) => call.payload.slideLabel), ['2']);
  assert.ok(frameCallList[0].payload.eventVideoTimeMs >= 2000 && frameCallList[0].payload.eventVideoTimeMs <= 2800);
  assert.ok(harness.bridge.sendList.some(({ payload }) => payload.reason?.startsWith('체류 미달')));
  assert.ok(harness.clock.nowPerf() - harness.ctx.state.lastScreenTransitionAt < 4000, '전환 기준 시각이 새 슬라이드로 옮겨짐');
  // 체류를 못 채운 화면은 main 의 회의 스크립트에서 그 전환을 빼도록 알린다(고지 요청 전이라 requestTs 는 없다).
  const cancelList = sendsOf(harness.bridge, 'pipeline-transition-cancelled');
  assert.deepEqual(cancelList.map(({ payload }) => payload), [{ slideLabel: '1', requestTs: null, transitionTs: harness.ctx.toWallTs(400) }]);
  assert.deepEqual(harness.warnList, []);
});

test('전환을 확정하면 고지가 정해질 때까지 진행 중으로 두고, 체류 미달·고지 미발행이면 풀어 준다(가상 시계 타이머만 쓴다)', async () => {
  const harness = createTestContext({
    handlerMap: {
      'embed-frame': async () => ({ isOk: true, embedding: harness.ctx.videoTimeMs() < 2000 ? [1, 0, 0] : [0, 1, 0] }),
      'pipeline-frame': async () => ({ isOk: true, isEmitted: false }),
    },
  });
  const slideGlue = createSlideGlue({
    ctx: harness.ctx, readFrameAt: async (timeMs) => (timeMs < 2000 ? RED : BLUE), slideFrameDir: makeTempDir('factory-slides-pending-'),
  });
  const { pendingTransitions } = harness.ctx.core;
  const settledList = [];
  const originalSettle = pendingTransitions.settle.bind(pendingTransitions);
  pendingTransitions.settle = (option) => {
    const isSettled = originalSettle(option);
    if (isSettled) settledList.push([option.slideLabel, option.status, harness.clock.elapsedMs()]);
    return isSettled;
  };
  slideGlue.start();
  await harness.clock.runUntil({ isDone: () => pendingTransitions.hasPending, deadlineElapsedMs: 1000 });
  assert.equal(pendingTransitions.hasPending, true, '슬라이드 1 확정 = 진행 중인 전환');
  await harness.clock.runUntil({ isDone: () => callsOf(harness.bridge, 'pipeline-frame').length === 1 && !pendingTransitions.hasPending });
  // 슬라이드 1 은 체류 미달로 취소, 슬라이드 2 는 고지를 내보내지 못해(기능 꺼짐 등) 풀린다.
  assert.deepEqual(settledList.map(([label, status]) => [label, status]), [['1', 'cancelled'], ['2', 'unscheduled']]);
  assert.equal(settledList[1][2], callsOf(harness.bridge, 'pipeline-frame')[0].atElapsedMs);
  const frameCall = callsOf(harness.bridge, 'pipeline-frame')[0];
  assert.equal(harness.ctx.state.slideTransitionRequestTsMap.get('2'), frameCall.payload.ts, '고지 요청 시각을 기억한다');
  slideGlue.stop();
  assert.equal(harness.clock.pendingTimerCount, 0, '풀린 전환은 10초 상한 타이머를 남기지 않는다');
  assert.deepEqual(harness.warnList, []);
});

test('확정 중에 온 첫 장 표시는 버리지 않고 기억했다가, 확정이 끝난 뒤 다음 표본에서 지금 화면을 첫 장으로 확정한다', async () => {
  const harness = setupSlides({ frameAt: () => RED });
  const verdictList = [{ isTransition: false, isFirst: true }, { isTransition: false, isFirst: false }];
  harness.ctx.core.histogramGate.sample = () => verdictList.shift();
  harness.ctx.state.isConfirmingSlide = true;
  harness.slideGlue.detectSlideTransition({ imageData: RED, ts: harness.clock.nowPerf() });
  assert.equal(callsOf(harness.bridge, 'embed-frame').length, 0, '확정 중에는 새로 확정하지 않는다');
  harness.ctx.state.isConfirmingSlide = false;
  harness.slideGlue.detectSlideTransition({ imageData: RED, ts: harness.clock.nowPerf() + 400 });
  await harness.clock.runUntil({ isDone: () => harness.ctx.core.slideRegistry.currentLabel() !== null, deadlineElapsedMs: 1000 });
  assert.equal(harness.ctx.core.slideRegistry.currentLabel(), '1');
  assert.ok(harness.bridge.sendList.some(({ payload }) => payload.reason === '첫 슬라이드 확정'));
  assert.deepEqual(harness.warnList, []);
});

test('GPU 임베딩이 실패하면 로컬 그리드 임베딩(임계 0.02)으로 이어 간다', async () => {
  const harness = setupSlides({ frameAt: () => RED, embedHandler: async () => ({ isOk: false, message: 'EMBED HTTP 502' }) });
  harness.slideGlue.start();
  await harness.clock.runUntil({ isDone: () => harness.ctx.core.slideRegistry.currentLabel() !== null });
  assert.equal(harness.ctx.core.slideRegistry.currentLabel(), '1');
  assert.equal(harness.ctx.state.hasWarnedLocalEmbedding, true);
  assert.deepEqual(harness.warnList, [LOCAL_EMBEDDING_WARNING], '폴백 경고는 한 번만');
});

test('작은 영역 움직임은 대기 중인 발화 후보에 포인팅 영역으로 붙는다', async () => {
  const box = { x: 60, y: 60, w: 60, h: 60 };
  const harness = setupSlides({ frameAt: (timeMs) => (timeMs >= 1200 ? solidFrame([200, 200, 200], box) : solidFrame([200, 200, 200])) });
  harness.ctx.core.candidateScheduler.submit({
    source: 'speech', utterance: '여기를 보세요', trigger: '여기', captureTs: harness.clock.nowPerf(), videoTimeMs: 0, chunkEndWallTs: harness.ctx.toWallTs(0),
  });
  harness.slideGlue.start();
  await harness.clock.runUntil({ isDone: () => Boolean(harness.ctx.core.candidateScheduler.pending?.region) || harness.clock.elapsedMs() > 2400 });
  const { region } = harness.ctx.core.candidateScheduler.pending;
  assert.ok(region && region.x <= 0.13 && region.x + region.w >= 0.25, JSON.stringify(region));
  assert.equal(harness.ctx.state.lastPointingMotionAt, harness.clock.nowPerf(), '디바운스 기준 시각을 남긴다');
  assert.deepEqual(harness.warnList, []);
});

// 400ms 표본마다 45px 씩 오른쪽으로 가는 점(펜·레이저)과, 같은 자리에서 나타났다 사라지는 깜빡임.
const POINTER_SIZE = 30;
const movingPointerAt = (timeMs) => solidFrame([200, 200, 200], { x: 30 + (timeMs / 400) * 45, y: 120, w: POINTER_SIZE, h: POINTER_SIZE });
const blinkingPointerAt = (timeMs) => solidFrame([200, 200, 200], (timeMs / 400) % 2 ? { x: 120, y: 120, w: POINTER_SIZE, h: POINTER_SIZE } : null);

test('점이 여러 칸을 지나며 움직이면 그 영역을 지금 슬라이드·가상 벽시계 시각과 함께 기억하고, 같은 자리 깜빡임은 기억하지 않는다', async () => {
  for (const [frameAt, isMoving] of [[movingPointerAt, true], [blinkingPointerAt, false]]) {
    const harness = setupSlides({ frameAt });
    harness.slideGlue.start();
    await harness.clock.runUntil({ isDone: () => harness.clock.elapsedMs() >= 2000 });
    harness.slideGlue.stop();
    const { recentPointingMemory, slideRegistry } = harness.ctx.core;
    assert.equal(slideRegistry.currentLabel(), '1');
    // 지시 발화 끝(가상 벽시계로 찍힌 조각 끝)과 견주므로 기억 시각도 가상 벽시계여야 꺼낼 수 있다.
    const recalled = recentPointingMemory.recall({ eventWallTs: harness.clock.nowWall(), slideLabel: '1' });
    assert.equal(Boolean(recalled?.region), isMoving, `움직임=${isMoving} 기억=${JSON.stringify(recalled)}`);
    assert.equal(recentPointingMemory.recall({ eventWallTs: harness.clock.nowWall(), slideLabel: '2' }), null, '다른 슬라이드로는 꺼내지 않는다');
    assert.deepEqual(harness.warnList, []);
  }
});

test('돌아온 슬라이드는 재방문으로 고지하고 글자 전사·base 프레임은 다시 하지 않는다', async () => {
  const embeddingAt = (timeMs) => (timeMs < 4000 || timeMs >= 8000 ? [1, 0, 0] : [0, 1, 0]);
  const harness = setupSlides({
    frameAt: (timeMs) => (timeMs < 4000 || timeMs >= 8000 ? RED : BLUE),
    embedHandler: async () => ({ isOk: true, embedding: embeddingAt(harness.ctx.videoTimeMs()) }),
  });
  harness.slideGlue.start();
  await harness.clock.runUntil({ isDone: () => sendsOf(harness.bridge, 'pipeline-slide-mark').length > 0 });
  const firstBasePath = sendsOf(harness.bridge, 'pipeline-slide-mark')[0].payload.filePath;
  fs.writeFileSync(firstBasePath, 'first-base');
  await harness.clock.runUntil({ isDone: () => sendsOf(harness.bridge, 'pipeline-slide-mark').length >= 3 });
  const frameCallList = callsOf(harness.bridge, 'pipeline-frame');
  assert.deepEqual(frameCallList.map(({ payload }) => [payload.slideLabel, payload.isRevisit, payload.eventVideoTimeMs]), [
    ['1', false, 400], ['2', false, 4400], ['1', true, 8400],
  ]);
  assert.deepEqual(callsOf(harness.bridge, 'pipeline-slide-text').map((call) => call.payload.slideLabel), ['1', '2']);
  const markList = sendsOf(harness.bridge, 'pipeline-slide-mark').map(({ payload }) => payload);
  assert.deepEqual(markList.map(({ slideLabel, transitionTs }) => [slideLabel, transitionTs]), [
    ['1', harness.ctx.toWallTs(400)], ['2', harness.ctx.toWallTs(4400)], ['1', harness.ctx.toWallTs(8400)],
  ]);
  assert.equal(markList[2].filePath, firstBasePath);
  assert.equal(fs.readFileSync(firstBasePath, 'utf8'), 'first-base', 'base 프레임은 슬라이드마다 한 번만 쓴다');
  assert.deepEqual(harness.warnList, []);
});

test('400ms 격자 시각마다 차례로 프레임을 읽고, stop 뒤나 캡처가 끝난 뒤에는 읽지 않는다', async () => {
  const readTimeList = [];
  const harness = setupSlides({ frameAt: (timeMs) => { readTimeList.push(timeMs); return RED; } });
  harness.slideGlue.start();
  await harness.clock.runUntil({ isDone: () => harness.clock.elapsedMs() >= 2000 });
  harness.slideGlue.stop();
  await harness.clock.runUntil({ isDone: () => false, deadlineElapsedMs: 4000 });
  assert.deepEqual(readTimeList, [400, 800, 1200, 1600, 2000]);
  harness.ctx.state.isCaptureActive = false;
  await harness.slideGlue.sampleFrame();
  assert.equal(readTimeList.length, 5);
  assert.deepEqual(harness.warnList, []);
});

test('프레임 읽기가 400ms 를 넘기면 그 사이 tick 은 건너뛰고 같은 시각 샘플을 두 번 돌리지 않는다', async () => {
  const readTimeList = [];
  const harness = setupSlides({
    frameAt: (timeMs) => {
      readTimeList.push(timeMs);
      if (timeMs !== 400) return RED;
      return new Promise((resolve) => { harness.clock.setTimeout(() => resolve(RED), 900); });
    },
  });
  harness.slideGlue.start();
  await harness.clock.runUntil({ isDone: () => harness.clock.elapsedMs() >= 2000 });
  assert.deepEqual(readTimeList, [400, 1600, 2000], '읽는 중에 온 800·1200 tick 은 버린다');
  const sampleTsList = harness.ctx.core.pointingLocator.sampleList.map(({ ts }) => ts);
  assert.equal(new Set(sampleTsList).size, sampleTsList.length, `같은 시각 표본이 겹쳤다: ${sampleTsList}`);
  assert.deepEqual(harness.warnList, []);
});

test('프레임 읽기가 실패하면 샘플러를 멈추고 경고 한 번과 함께 오류를 상태에 남긴다', async () => {
  const readTimeList = [];
  const harness = setupSlides({
    frameAt: (timeMs) => {
      readTimeList.push(timeMs);
      if (timeMs >= 1200) throw new Error('ffmpeg 프레임 디코드 실패(종료 코드 1)');
      return RED;
    },
  });
  assert.equal(harness.ctx.state.frameSourceError, null);
  harness.slideGlue.start();
  await harness.clock.runUntil({ isDone: () => false, deadlineElapsedMs: 3000 });
  assert.deepEqual(readTimeList, [400, 800, 1200], '실패 뒤로는 읽지 않는다');
  assert.deepEqual(harness.ctx.state.frameSourceError, { message: 'ffmpeg 프레임 디코드 실패(종료 코드 1)', videoTimeMs: 1200 });
  assert.equal(harness.warnList.length, 1);
  assert.match(harness.warnList[0], /ffmpeg 프레임 디코드 실패/);
});

test('stop 은 읽는 중인 샘플 결과도 버리고 다음 tick 을 막는다', async () => {
  const readTimeList = [];
  const harness = setupSlides({
    frameAt: (timeMs) => {
      readTimeList.push(timeMs);
      return new Promise((resolve) => { harness.clock.setTimeout(() => resolve(RED), 300); });
    },
  });
  harness.slideGlue.start();
  harness.clock.setTimeout(() => harness.slideGlue.stop(), 500);
  await harness.clock.runUntil({ isDone: () => false, deadlineElapsedMs: 2000 });
  assert.deepEqual(readTimeList, [400]);
  assert.equal(harness.ctx.core.pointingLocator.sampleList.length, 0, '읽는 사이 stop 된 샘플은 처리하지 않는다');
  assert.equal(callsOf(harness.bridge, 'embed-frame').length, 0);
  assert.deepEqual(harness.warnList, []);
});
