import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleepReal } from 'node:timers/promises';
import { createVirtualClock } from '../src/clock/virtual-clock.mjs';
import { classifyServiceUrl, createScopedFetch, computeServiceStats } from '../src/clock/scoped-fetch.mjs';
import { createIpcBridge, createRequestContextStorage } from '../src/product/ipc-bridge.mjs';

const pipelineConfig = {
  vlmUrl: 'http://127.0.0.1:8801/v1/chat/completions', vlmModel: 'qwen', asrUrl: 'http://127.0.0.1:8802/asr',
  ttsUrl: 'http://127.0.0.1:8803/tts', ttsLongUrl: 'http://127.0.0.1:8803/tts-long', embedUrl: 'http://127.0.0.1:8804/embed',
  vlmFallbackModelId: 'anthropic.claude-haiku-4-5-20251001-v1:0',
};

test('URL 로 서비스와 Bedrock 모델·VLM 폴백 여부를 가린다', () => {
  assert.deepEqual(classifyServiceUrl({ url: 'http://127.0.0.1:8802/asr?startTs=1&language=ko', pipelineConfig }),
    { service: 'asr', modelId: null, isVlmFallback: false });
  assert.equal(classifyServiceUrl({ url: pipelineConfig.vlmUrl, pipelineConfig }).modelId, 'qwen');
  assert.deepEqual(classifyServiceUrl({
    url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-haiku-4-5-20251001-v1:0/converse', pipelineConfig,
  }), { service: 'bedrock', modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', isVlmFallback: true });
  assert.equal(classifyServiceUrl({
    url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-sonnet-5/converse', pipelineConfig,
  }).isVlmFallback, false);
});

test('호출 동안 진행 중 수가 1 이고, 몸통까지 받은 뒤 0 이 되며 요청 문맥에 기록이 붙는다', async () => {
  const clock = createVirtualClock();
  const requestContextStorage = createRequestContextStorage();
  let inFlightDuringCall = null;
  const baseFetch = async () => {
    inFlightDuringCall = clock.inFlightCount;
    await sleepReal(30);
    return new Response(JSON.stringify({ text: '안녕하세요' }), { status: 200 });
  };
  const scoped = createScopedFetch({ clock, pipelineConfig, requestContextStorage, baseFetch });
  const context = { seq: 7, channel: 'pipeline-audio', callList: [] };
  const body = await requestContextStorage.run(context, async () => (await scoped.fetch('http://127.0.0.1:8802/asr?startTs=1')).json());
  assert.deepEqual(body, { text: '안녕하세요' });
  assert.equal(inFlightDuringCall, 1);
  assert.equal(clock.inFlightCount, 0);
  assert.equal(context.callList.length, 1);
  assert.equal(context.callList[0].requestSeq, 7);
  assert.ok(context.callList[0].elapsedMs >= 25);
});

test('실패한 호출도 진행 중 수를 되돌리고 오류를 남긴다', async () => {
  const clock = createVirtualClock();
  const scoped = createScopedFetch({
    clock, pipelineConfig, requestContextStorage: createRequestContextStorage(),
    baseFetch: async () => { throw new Error('connect ECONNREFUSED'); },
  });
  await assert.rejects(scoped.fetch(pipelineConfig.ttsUrl, { method: 'POST' }), /ECONNREFUSED/);
  assert.equal(clock.inFlightCount, 0);
  assert.equal(scoped.getCallLog()[0].errorMessage, 'connect ECONNREFUSED');
});

test('서비스별 호출 수·오류 수·p50/p95 를 낸다', () => {
  const callLog = [10, 20, 30, 40, 1000].map((elapsedMs) => ({ service: 'asr', elapsedMs, errorMessage: null, status: 200 }));
  callLog.push({ service: 'asr', elapsedMs: 5, errorMessage: 'HTTP 500', status: 500 });
  const stats = computeServiceStats({ callLog });
  assert.equal(stats.serviceMap.asr.count, 6);
  assert.equal(stats.serviceMap.asr.errorCount, 1);
  assert.equal(stats.serviceMap.asr.p50Ms, 20);
  assert.equal(stats.serviceMap.asr.p95Ms, 1000);
});

test('IPC 다리는 다음 차례에 핸들러를 부르고, main 이 보낸 이벤트를 요청 문맥과 함께 렌더러 쪽에 넘긴다', async () => {
  const requestContextStorage = createRequestContextStorage();
  const handlerMap = new Map();
  const receivedDebugList = [];
  const listenerMap = new Map([['pipeline-debug', [(_event, payload) => receivedDebugList.push(payload)]]]);
  const bridge = createIpcBridge({ registry: { handlerMap, listenerMap }, requestContextStorage });
  const viewerView = bridge.createViewerView();
  const eventList = [];
  bridge.onRendererEvent('pipeline-event', (event) => eventList.push(event));
  let isHandlerCalled = false;
  handlerMap.set('pipeline-audio', async (_event, payload) => {
    isHandlerCalled = true;
    requestContextStorage.getStore().callList.push({ service: 'asr' });
    viewerView.webContents.send('pipeline-event', { type: 'asr', text: payload.text });
    return { isOk: true };
  });
  const pending = bridge.invokeWithContext('pipeline-audio', { text: '하나' });
  const isHandlerCalledSynchronously = isHandlerCalled;
  const { result, requestContext } = await pending;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(isHandlerCalledSynchronously, false, 'Electron invoke 처럼 다음 차례에 받는다');
  assert.deepEqual(result, { isOk: true });
  assert.equal(requestContext.channel, 'pipeline-audio');
  assert.equal(eventList[0].payload.text, '하나');
  assert.equal(eventList[0].requestContext, requestContext);
  bridge.send('pipeline-debug', { reason: '테스트' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(receivedDebugList, [{ reason: '테스트' }]);
  await assert.rejects(bridge.invoke('없는-채널', {}), /ipcMain 핸들러가 없다/);
});
