import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockServices } from './helpers/mock-services.mjs';
import { createVirtualClock } from '../src/clock/virtual-clock.mjs';
import { bootProductPipeline } from '../src/product/boot-pipeline.mjs';
import { getTriggerAnalyzerCountMap } from '../src/product/product-loader.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const mock = await startMockServices();
Object.assign(process.env, mock.urlEnv);
delete process.env.AWS_BEARER_TOKEN_BEDROCK;
const outDir = makeTempDir('factory-boot-');
const clock = createVirtualClock({ startWallMs: 1_800_000_000_000 });
const { bridge, scopedFetch, waitTriggerReady } = bootProductPipeline({ outDir, clock, log: console });
// 제품 앱처럼 회의(세션) 전에 Kiwi 형태소 분석기 준비를 기다린다. 그동안 가상 시간은 흐르지 않는다.
await waitTriggerReady();
assert.equal(clock.elapsedMs(), 0);
const eventList = [];
bridge.onRendererEvent('pipeline-event', (event) => eventList.push(event));
after(() => mock.close());

async function invokeUnderClock(channel, payload) {
  let result = null;
  bridge.invoke(channel, payload).then((value) => { result = value ?? {}; });
  await clock.runUntil({ isDone: () => result !== null, deadlineElapsedMs: clock.elapsedMs() + 30000 });
  return result;
}

test('pipeline-audio → mock ASR → pipeline-event asr 가 요청 문맥과 함께 오고 시계 진행 중 수가 0 으로 돌아온다', async () => {
  await invokeUnderClock('pipeline-session-start', { mode: 'delayed', asrLanguage: 'ko' });
  const startTs = clock.nowWall();
  const result = await invokeUnderClock('pipeline-audio', { startTs, endTs: startTs + 3000, buffer: new Uint8Array([1, 2, 3]), speakerHint: null });
  await clock.settle();
  assert.equal(result.isOk, true);
  const asrEvent = eventList.find((event) => event.payload.type === 'asr');
  assert.equal(asrEvent.payload.text, '오늘은 매출 구조를 설명하겠습니다.');
  assert.equal(asrEvent.requestContext.channel, 'pipeline-audio');
  assert.deepEqual(asrEvent.requestContext.callList.map((call) => call.service), ['asr']);
  assert.equal(clock.inFlightCount, 0);
  assert.equal(scopedFetch.summarizeServiceStats().serviceMap.asr.count, 1);
});

test('ASR 이 500 을 돌려도 멈추지 않고 실패가 통계에 남는다', async () => {
  mock.setAsrStatus(500);
  const startTs = clock.nowWall();
  const result = await invokeUnderClock('pipeline-audio', { startTs, endTs: startTs + 3000, buffer: new Uint8Array([1]), speakerHint: null });
  mock.setAsrStatus(200);
  assert.equal(result.isOk, false);
  assert.match(result.message, /ASR HTTP 500/);
  assert.equal(scopedFetch.summarizeServiceStats().serviceMap.asr.errorCount, 1);
});

test('main 트리거가 전사를 Kiwi 로 분석해 asr 이벤트에 후보 구(triggerCandidateList)를 실어 보낸다', async () => {
  const startTs = clock.nowWall();
  const before = eventList.length;
  await invokeUnderClock('pipeline-audio', { startTs, endTs: startTs + 3000, buffer: new Uint8Array([1, 2]), speakerHint: null, isSpeakerTracked: false });
  await clock.settle();
  const asrEvent = eventList.slice(before).find((event) => event.payload.type === 'asr');
  assert.equal(asrEvent.payload.text, '이 그래프를 보시면 매출이 크게 늘었습니다.');
  assert.deepEqual(asrEvent.payload.triggerCandidateList.map(({ type, phrase }) => [type, phrase]), [['demonstrative', '이 그래프'], ['change', '크게 늘었습니다']]);
  assert.equal(getTriggerAnalyzerCountMap().rule, undefined, 'Kiwi 가 준비돼 대체 규칙을 쓰지 않는다');
  assert.ok(getTriggerAnalyzerCountMap().kiwi >= 2);
});
