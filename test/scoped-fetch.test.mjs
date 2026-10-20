import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import net from 'node:net';
import { setTimeout as sleepReal } from 'node:timers/promises';
import { createVirtualClock } from '../src/clock/virtual-clock.mjs';
import {
  classifyServiceUrl, classifyServiceRequest, isJudgeRequestBody, createScopedFetch, computeServiceStats,
} from '../src/clock/scoped-fetch.mjs';
import { createIpcBridge, createRequestContextStorage } from '../src/product/ipc-bridge.mjs';
import { resolveProductPath } from '../src/product/product-paths.mjs';

const require = createRequire(import.meta.url);
const { buildVlmRequestBody } = require(resolveProductPath('src/main/caption-pipeline/agents/shared/vlm-gateway.js'));
const { createJudgeLlm } = require(resolveProductPath('src/main/caption-pipeline/agents/shared/judge-llm.js'));
const { createUnifiedRouter } = require(resolveProductPath('src/main/caption-pipeline/router/unified-router.js'));
const { createSilenceJudge } = require(resolveProductPath('src/main/caption-pipeline/router/silence-judge.js'));
const { createDeixisJudgeClient } = require(resolveProductPath('src/main/caption-pipeline/router/deixis-judge.js'));

const pipelineConfig = {
  vlmUrl: 'http://127.0.0.1:8801/v1/chat/completions', vlmModel: 'qwen', asrUrl: 'http://127.0.0.1:8802/asr',
  ttsUrl: 'http://127.0.0.1:8803/tts', ttsLongUrl: 'http://127.0.0.1:8803/tts-long', embedUrl: 'http://127.0.0.1:8804/embed',
};
// 판정 GPU 주소를 VLM 주소와 같게 둔 설정(SEEON_JUDGE_GPU_URL)이다. 모델 이름만 달리 둬 어느 쪽으로 셌는지 가린다.
const sharedJudgeConfig = { ...pipelineConfig, judgeBackend: 'gpu', judgeGpuUrl: pipelineConfig.vlmUrl, judgeGpuModel: 'qwen-judge' };
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);

// 제품 판정기(라우터·무발화·지시)가 실제로 보내는 GPU 요청 몸통을 붙잡는다. 네트워크는 쓰지 않는다.
async function captureJudgeBodyList() {
  const bodyList = [];
  const config = { ...sharedJudgeConfig, bedrockApiKey: '' };
  const fetchImpl = async (_url, init) => {
    bodyList.push(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 });
  };
  const judgeLlm = createJudgeLlm({ config, fetchImpl });
  await createUnifiedRouter({ config, judgeLlm }).route({
    utterance: '이 그래프를 보시면', before: '매출입니다.', after: '', candidateList: [{ type: 'demonstrative', phrase: '이 그래프', start: 0, end: 5 }],
  });
  await createSilenceJudge({ config, judgeLlm }).judge({ transcript: '이 화면을 보시죠', silenceMs: 6000 });
  await createDeixisJudgeClient({ config, judgeLlm }).judge({ utterance: '여기 이 부분', before: '', after: '' });
  return bodyList;
}

test('판정 요청 몸통: 제품 판정기 세 개의 GPU 요청은 판정, VLM 요청은 이미지가 없는 글 요청(라벨링·질문 라우팅)까지 판정이 아니다', async () => {
  const judgeBodyList = await captureJudgeBodyList();
  assert.equal(judgeBodyList.length, 3);
  for (const body of judgeBodyList) assert.equal(isJudgeRequestBody(body), true, body.slice(0, 200));
  const imageBody = JSON.stringify(buildVlmRequestBody({ jpegBuffer: FAKE_JPEG, vlmModel: 'qwen', prompt: '화면 유형을 분류하라' }));
  const textOnlyBody = JSON.stringify(buildVlmRequestBody({ vlmModel: 'qwen', prompt: '이 슬라이드에 라벨을 붙여라', temperature: 0 }));
  assert.equal(isJudgeRequestBody(imageBody), false);
  assert.equal(isJudgeRequestBody(textOnlyBody), false);
  for (const body of [undefined, null, '', '깨진 JSON', '{}', '{"messages":[]}', new Uint8Array([1, 2])]) {
    assert.equal(isJudgeRequestBody(body), false, String(body));
  }
});

test('판정 GPU 주소가 VLM 과 같으면 몸통으로 판정과 VLM 을 가르고, 판정은 판정 GPU 모델로 센다', async () => {
  const [routerBody] = await captureJudgeBodyList();
  const textOnlyBody = JSON.stringify(buildVlmRequestBody({ vlmModel: 'qwen', prompt: '이 슬라이드에 라벨을 붙여라' }));
  assert.deepEqual(classifyServiceRequest({ url: pipelineConfig.vlmUrl, body: routerBody, pipelineConfig: sharedJudgeConfig }),
    { service: 'judge', modelId: 'qwen-judge' });
  assert.deepEqual(classifyServiceRequest({ url: pipelineConfig.vlmUrl, body: textOnlyBody, pipelineConfig: sharedJudgeConfig }),
    { service: 'vlm', modelId: 'qwen' });
  assert.equal(classifyServiceRequest({ url: pipelineConfig.vlmUrl, body: undefined, pipelineConfig: sharedJudgeConfig }).service, 'vlm');
  assert.equal(classifyServiceRequest({ url: pipelineConfig.vlmUrl, body: routerBody, pipelineConfig }).service, 'vlm', '판정 설정이 없는 제품');
  assert.equal(classifyServiceRequest({ url: pipelineConfig.asrUrl, body: routerBody, pipelineConfig: sharedJudgeConfig }).service, 'asr');
});

test('제품 기본 설정은 판정 LLM(8805)을 VLM(8801)과 따로 두므로 주소만으로 가르고, VLM 주소로 간 글 요청은 VLM 이다', async () => {
  const { readPipelineConfig } = require(resolveProductPath('src/main/caption-pipeline/config.js'));
  const defaultConfig = readPipelineConfig({});
  assert.deepEqual([defaultConfig.vlmUrl, defaultConfig.judgeGpuUrl],
    ['http://127.0.0.1:8801/v1/chat/completions', 'http://127.0.0.1:8805/v1/chat/completions']);
  // 모델 이름은 제품 기본값을 그대로 쓴다(GPU 서버 모델을 바꿀 때마다 제품 기본값이 바뀐다).
  assert.ok(defaultConfig.judgeGpuModel && defaultConfig.vlmModel);
  const [routerBody] = await captureJudgeBodyList();
  assert.deepEqual(classifyServiceRequest({ url: defaultConfig.judgeGpuUrl, body: routerBody, pipelineConfig: defaultConfig }),
    { service: 'judge', modelId: defaultConfig.judgeGpuModel });
  assert.deepEqual(classifyServiceRequest({ url: defaultConfig.vlmUrl, body: routerBody, pipelineConfig: defaultConfig }),
    { service: 'vlm', modelId: defaultConfig.vlmModel }, '판정 주소가 따로면 VLM 주소의 몸통은 보지 않는다');
});

test('판정 GPU 주소가 따로 있으면 주소만으로 판정으로 센다', () => {
  const dedicatedJudgeConfig = { ...sharedJudgeConfig, judgeGpuUrl: 'http://127.0.0.1:18806/v1/chat/completions' };
  assert.deepEqual(classifyServiceUrl({ url: dedicatedJudgeConfig.judgeGpuUrl, pipelineConfig: dedicatedJudgeConfig }),
    { service: 'judge', modelId: 'qwen-judge' });
  assert.equal(classifyServiceRequest({ url: dedicatedJudgeConfig.judgeGpuUrl, body: undefined, pipelineConfig: dedicatedJudgeConfig }).service, 'judge');
  assert.equal(classifyServiceUrl({ url: pipelineConfig.vlmUrl, pipelineConfig: dedicatedJudgeConfig }).service, 'vlm');
});

test('같은 주소로 간 판정·VLM 호출은 서비스 통계에서 따로 잡힌다', async () => {
  const [routerBody] = await captureJudgeBodyList();
  const imageBody = JSON.stringify(buildVlmRequestBody({ jpegBuffer: FAKE_JPEG, vlmModel: 'qwen', prompt: '화면 유형을 분류하라' }));
  const scoped = createScopedFetch({
    clock: createVirtualClock(), pipelineConfig: sharedJudgeConfig, requestContextStorage: createRequestContextStorage(),
    baseFetch: async () => new Response('{}', { status: 200 }),
  });
  await scoped.fetch(pipelineConfig.vlmUrl, { method: 'POST', body: routerBody });
  await scoped.fetch(pipelineConfig.vlmUrl, { method: 'POST', body: imageBody });
  await scoped.fetch(pipelineConfig.vlmUrl, { method: 'POST', body: routerBody });
  assert.deepEqual(scoped.getCallLog().map((record) => [record.service, record.modelId]), [['judge', 'qwen-judge'], ['vlm', 'qwen'], ['judge', 'qwen-judge']]);
  const { serviceMap } = scoped.summarizeServiceStats();
  assert.equal(serviceMap.judge.count, 2);
  assert.equal(serviceMap.vlm.count, 1);
});

test('URL 로 서비스와 Bedrock 모델을 가린다', () => {
  assert.deepEqual(classifyServiceUrl({ url: 'http://127.0.0.1:8802/asr?startTs=1&language=ko', pipelineConfig }),
    { service: 'asr', modelId: null });
  assert.equal(classifyServiceUrl({ url: pipelineConfig.vlmUrl, pipelineConfig }).modelId, 'qwen');
  assert.deepEqual(classifyServiceUrl({
    url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-sonnet-5/converse', pipelineConfig,
  }), { service: 'bedrock', modelId: 'us.anthropic.claude-sonnet-5' });
  assert.deepEqual(classifyServiceUrl({ url: 'http://127.0.0.1:9999/unknown', pipelineConfig }), { service: 'other', modelId: null });
});

test('슬라이드 전사 OCR(/ocr)은 임베딩과 origin 이 같아도 경로로 갈라 ocr 로 센다', () => {
  const { readPipelineConfig } = require(resolveProductPath('src/main/caption-pipeline/config.js'));
  const productConfig = readPipelineConfig({ SEEON_SLIDE_TEXT_BACKEND: 'ocr' });
  assert.equal(productConfig.ocrUrl, 'http://127.0.0.1:8804/ocr', '제품 기본 OCR 주소는 임베딩 origin + /ocr');
  assert.equal(classifyServiceUrl({ url: productConfig.ocrUrl, pipelineConfig: productConfig }).service, 'ocr');
  assert.equal(classifyServiceUrl({ url: productConfig.embedUrl, pipelineConfig: productConfig }).service, 'embed');
  const splitConfig = readPipelineConfig({ SEEON_OCR_URL: 'http://127.0.0.1:8806/ocr' });
  assert.equal(classifyServiceUrl({ url: 'http://127.0.0.1:8806/ocr', pipelineConfig: splitConfig }).service, 'ocr', 'SEEON_OCR_URL 로 나눈 주소');
  assert.equal(classifyServiceUrl({ url: 'http://127.0.0.1:8804/ocr', pipelineConfig: splitConfig }).service, 'other', '설정과 다른 주소는 OCR 로 세지 않는다');
  const { serviceMap } = computeServiceStats({ callLog: [{ service: 'ocr', elapsedMs: 300, status: 200 }, { service: 'ocr', elapsedMs: 500, status: 422 }] });
  assert.deepEqual(serviceMap.ocr, { count: 2, errorCount: 1, p50Ms: 300, p95Ms: 500, maxMs: 500 });
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

test('IPC 다리는 리스너 오류를 경고만 하고 삼키되 채널별로 센다', async () => {
  const warnList = [];
  const listenerMap = new Map([['pipeline-debug', [() => { throw new Error('리스너 버그'); }]]]);
  const bridge = createIpcBridge({ registry: { handlerMap: new Map(), listenerMap }, requestContextStorage: createRequestContextStorage(), log: { warn: (message) => warnList.push(message) } });
  bridge.onRendererEvent('pipeline-event', () => { throw new Error('렌더러 버그'); });
  assert.deepEqual(bridge.getSwallowedErrorCountMap(), {});
  bridge.send('pipeline-debug', { reason: '하나' });
  bridge.send('pipeline-debug', { reason: '둘' });
  bridge.createViewerView().webContents.send('pipeline-event', { type: 'asr' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(bridge.getSwallowedErrorCountMap(), { 'pipeline-debug': 2, 'pipeline-event': 1 });
  assert.equal(warnList.length, 3);
});

test('실제 fetch 가 실패하면 undici 가 cause 에 둔 원인(코드·문구)과 오류 이름까지 기록한다', async () => {
  const clock = createVirtualClock();
  // 닫힌 포트(연결 거부)와 받기만 하고 답하지 않는 서버(시간 초과). GPU 실서비스 포트는 쓰지 않는다.
  const closedServer = net.createServer();
  await new Promise((resolve) => { closedServer.listen(0, '127.0.0.1', resolve); });
  const closedUrl = `http://127.0.0.1:${closedServer.address().port}/asr`;
  await new Promise((resolve) => { closedServer.close(resolve); });
  const silentServer = http.createServer(() => {});
  await new Promise((resolve) => { silentServer.listen(0, '127.0.0.1', resolve); });
  const silentUrl = `http://127.0.0.1:${silentServer.address().port}/tts`;
  try {
    const scoped = createScopedFetch({
      clock, pipelineConfig: { ...pipelineConfig, asrUrl: closedUrl, ttsUrl: silentUrl }, requestContextStorage: createRequestContextStorage(),
    });
    await assert.rejects(scoped.fetch(closedUrl, { method: 'POST' }), /fetch failed/);
    await assert.rejects(scoped.fetch(silentUrl, { method: 'POST', signal: AbortSignal.timeout(100) }), { name: 'TimeoutError' });
    const [refused, timedOut] = scoped.getCallLog();
    assert.equal(refused.service, 'asr');
    assert.equal(refused.errorName, 'TypeError');
    assert.equal(refused.errorCode, 'ECONNREFUSED');
    assert.match(refused.errorMessage, /^fetch failed \(ECONNREFUSED: connect ECONNREFUSED 127\.0\.0\.1:\d+\)$/);
    assert.equal(timedOut.service, 'tts');
    assert.equal(timedOut.errorName, 'TimeoutError');
    assert.equal(timedOut.errorCode, null);
  } finally {
    silentServer.closeAllConnections();
    await new Promise((resolve) => { silentServer.close(resolve); });
  }
});

test('주소에 사용자 정보(user:pass@)가 있으면 undici 가 그 주소를 오류 문구에 담아 거부하는데, 기록에는 비밀번호를 지운 문구만 남긴다', async () => {
  // undici 는 요청을 만들 때 거부하므로 연결을 시도하지 않는다. 포트는 쓰지 않는 9 다.
  const ttsUrl = 'http://user:secretpw@127.0.0.1:9/tts';
  const scoped = createScopedFetch({ clock: createVirtualClock(), pipelineConfig: { ...pipelineConfig, ttsUrl }, requestContextStorage: createRequestContextStorage() });
  await assert.rejects(scoped.fetch(ttsUrl, { method: 'POST' }), /secretpw/, '던지는 오류는 제품에 그대로 간다');
  const [record] = scoped.getCallLog();
  assert.equal(record.service, 'tts');
  assert.match(record.errorMessage, /credentials: http:\/\/127\.0\.0\.1:9\/tts/);
  assert.equal(record.errorMessage.includes('secretpw'), false);
  assert.equal(record.errorMessage.includes('user:'), false);
});
