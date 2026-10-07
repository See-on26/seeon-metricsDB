import { createVirtualClock } from '../../src/clock/virtual-clock.mjs';
import { createSessionContext } from '../../src/session/session-context.mjs';
import { buildFeatureToggleStore } from '../../src/session/feature-preset.mjs';
import { MODE_MAP } from '../../src/product/core-modules.mjs';

export function createFakeBridge({ clock, handlerMap = {} }) {
  const invokeList = [];
  const sendList = [];
  async function invokeWithContext(channel, payload) {
    invokeList.push({ channel, payload, atElapsedMs: clock.elapsedMs() });
    const handler = handlerMap[channel];
    const result = handler ? await handler(payload) : { isOk: true };
    return { result, requestContext: { seq: invokeList.length, channel, callList: [] } };
  }
  return {
    invokeList, sendList, invokeWithContext,
    invoke: async (channel, payload) => (await invokeWithContext(channel, payload)).result,
    send: (channel, payload) => sendList.push({ channel, payload, atElapsedMs: clock.elapsedMs() }),
  };
}

export function levelListFrom(patternList, tickMs = 100) {
  const totalMs = patternList.reduce((sum, [ms]) => sum + ms, 0);
  const levelList = new Float32Array(Math.floor(totalMs / tickMs));
  for (let tick = 1; tick <= levelList.length; tick += 1) {
    let boundaryMs = 0;
    for (const [ms, level] of patternList) {
      boundaryMs += ms;
      if (tick * tickMs <= boundaryMs) { levelList[tick - 1] = level; break; }
    }
  }
  return levelList;
}

// 세션 시작 = 가상 경과 0 = 영상 0ms. 프레임 캡처는 시각·영역만 기록하고 가짜 JPEG 를 돌려준다.
// 연결 코드가 삼킨 오류(trackTask 경고)는 warnList 에 모아 테스트가 비어 있는지 확인한다.
export function createTestContext({ levelList = new Float32Array(600), mediaDurationMs = 60000, handlerMap = {}, isPageTransitionIncluded = false } = {}) {
  const clock = createVirtualClock({ startWallMs: 1_800_000_000_000 });
  const bridge = createFakeBridge({ clock, handlerMap });
  const captureList = [];
  const warnList = [];
  const ctx = createSessionContext({
    clock, bridge, mode: MODE_MAP.delayed, featureToggleStore: buildFeatureToggleStore({ isPageTransitionIncluded }),
    mediaDurationMs, levelList, log: { log() {}, warn: (message) => warnList.push(message) },
    captureFrameJpeg: async ({ normRect = null } = {}) => {
      captureList.push({ videoTimeMs: ctx.videoTimeMs(), normRect });
      return Buffer.from('jpeg');
    },
  });
  ctx.markSessionStart();
  ctx.state.isCaptureActive = true;
  ctx.state.isSessionActive = true;
  ctx.state.lastScreenTransitionAt = clock.nowPerf();
  return { clock, bridge, ctx, captureList, warnList };
}
