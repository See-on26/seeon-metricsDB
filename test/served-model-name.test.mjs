import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { listModelNameProblems, fetchServedModelIdList, inspectGpuServices, runPreflight } from '../src/runner/preflight.mjs';

// GPU 실서비스 포트(8801–8805)는 쓰지 않는다. 가짜 목록을 주는 대역이나 빈 포트에 띄운 로컬 서버만 쓴다.
const GEMMA = 'gemma-4-26b-a4b-qat';
const VLM_URL = 'http://127.0.0.1:18801/v1/chat/completions';
const JUDGE_URL = 'http://127.0.0.1:18805/v1/chat/completions';
const ENV_HINT = '.env 의 SEEON_VLM_MODEL·SEEON_JUDGE_GPU_MODEL 을 확인한다';
const GPU_JUDGE_CONFIG = { vlmUrl: VLM_URL, vlmModel: GEMMA, judgeBackend: 'gpu', judgeGpuUrl: JUDGE_URL, judgeGpuModel: GEMMA };
const SERVICE_UP = { isUp: true, detail: 'HTTP 405' };

function recordFetch(modelIdList) {
  const fetchedUrlList = [];
  const fetchModelIdList = async ({ url }) => { fetchedUrlList.push(url); return modelIdList; };
  return { fetchedUrlList, fetchModelIdList };
}

test('서빙 이름: 서버 목록에 설정 이름이 없으면 VLM·판정마다 기대 이름과 서버 목록을 담아 낸다', async () => {
  const { fetchedUrlList, fetchModelIdList } = recordFetch(['qwen3.5-9b']);
  const problemList = await listModelNameProblems({ pipelineConfig: GPU_JUDGE_CONFIG, fetchModelIdList });
  assert.deepEqual(fetchedUrlList, [VLM_URL, JUDGE_URL]);
  assert.deepEqual(problemList, [
    `VLM 127.0.0.1:18801 에 모델 ${GEMMA} 이 없다(서버: qwen3.5-9b) — ${ENV_HINT}`,
    `판정 127.0.0.1:18805 에 모델 ${GEMMA} 이 없다(서버: qwen3.5-9b) — ${ENV_HINT}`,
  ]);
  const twoModel = await listModelNameProblems({ pipelineConfig: GPU_JUDGE_CONFIG, fetchModelIdList: async () => ['qwen3.5-35b-a3b', 'qwen3.5-9b'] });
  assert.match(twoModel[0], /\(서버: qwen3\.5-35b-a3b, qwen3\.5-9b\)/, '서버 목록은 쉼표로 잇는다');
});

test('서빙 이름: 설정 이름이 서버 목록에 있으면 문제가 없고, 설정에 이름이 없으면 그 자리는 보지 않는다', async () => {
  assert.deepEqual(await listModelNameProblems({ pipelineConfig: GPU_JUDGE_CONFIG, fetchModelIdList: async () => [GEMMA] }), []);
  assert.deepEqual(await listModelNameProblems({ pipelineConfig: GPU_JUDGE_CONFIG, fetchModelIdList: async () => ['other', GEMMA] }), []);
  const { fetchedUrlList, fetchModelIdList } = recordFetch(['qwen3.5-9b']);
  const noVlmModel = await listModelNameProblems({ pipelineConfig: { ...GPU_JUDGE_CONFIG, vlmModel: undefined }, fetchModelIdList });
  assert.deepEqual(fetchedUrlList, [JUDGE_URL]);
  assert.equal(noVlmModel.length, 1);
  assert.match(noVlmModel[0], /^판정 /);
});

test('서빙 이름: 판정 백엔드가 bedrock 이거나 판정 GPU 주소가 없으면 판정 주소는 보지 않는다', async () => {
  for (const judgeConfig of [{ judgeBackend: 'bedrock' }, { judgeGpuUrl: '' }]) {
    const { fetchedUrlList, fetchModelIdList } = recordFetch(['qwen3.5-9b']);
    const problemList = await listModelNameProblems({ pipelineConfig: { ...GPU_JUDGE_CONFIG, ...judgeConfig }, fetchModelIdList });
    assert.deepEqual(fetchedUrlList, [VLM_URL]);
    assert.deepEqual(problemList, [`VLM 127.0.0.1:18801 에 모델 ${GEMMA} 이 없다(서버: qwen3.5-9b) — ${ENV_HINT}`]);
  }
});

test('서빙 이름: VLM 과 판정이 같은 호스트·포트면 목록은 한 번만 받고 두 이름을 모두 본다', async () => {
  const { fetchedUrlList, fetchModelIdList } = recordFetch([GEMMA]);
  const problemList = await listModelNameProblems({
    pipelineConfig: { ...GPU_JUDGE_CONFIG, judgeGpuUrl: 'http://127.0.0.1:18801/v1/chat/completions', judgeGpuModel: 'qwen3.5-9b' }, fetchModelIdList,
  });
  assert.equal(fetchedUrlList.length, 1);
  assert.deepEqual(problemList, [`판정 127.0.0.1:18801 에 모델 qwen3.5-9b 이 없다(서버: ${GEMMA}) — ${ENV_HINT}`]);
});

test('서빙 이름: 목록을 받지 못하면(닿지 않음·응답 이상) 건너뛴다 — 닿지 않는 것은 GPU 서비스 점검이 잡는다', async () => {
  const unreachable = async () => { throw new Error('연결 거부(ECONNREFUSED)'); };
  assert.deepEqual(await listModelNameProblems({ pipelineConfig: GPU_JUDGE_CONFIG, fetchModelIdList: unreachable }), []);
  const judgeOnlyDown = async ({ url }) => { if (url === JUDGE_URL) throw new Error('응답 없음'); return ['qwen3.5-35b-a3b']; };
  assert.deepEqual(await listModelNameProblems({ pipelineConfig: GPU_JUDGE_CONFIG, fetchModelIdList: judgeOnlyDown }), [
    `VLM 127.0.0.1:18801 에 모델 ${GEMMA} 이 없다(서버: qwen3.5-35b-a3b) — ${ENV_HINT}`,
  ]);
});

test('시작 전 점검: 서빙 이름이 어긋나면 problemList 에 넣어 멈추고, 터널을 연 뒤 다시 보는 GPU 서비스 점검도 같은 문제를 낸다', async () => {
  const pipelineConfig = { ...GPU_JUDGE_CONFIG, asrUrl: 'http://127.0.0.1:18802/asr', bedrockApiKey: 'token' };
  const { problemList, downServiceList } = await runPreflight({
    pipelineConfig, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', runVersion: async () => Buffer.from('ok'), checkTriggerAnalyzer: async () => [],
    checkService: async () => SERVICE_UP, fetchModelIdList: async () => ['qwen3.5-9b'],
  });
  assert.deepEqual(downServiceList, []);
  assert.deepEqual(problemList, [
    `VLM 127.0.0.1:18801 에 모델 ${GEMMA} 이 없다(서버: qwen3.5-9b) — ${ENV_HINT}`,
    `판정 127.0.0.1:18805 에 모델 ${GEMMA} 이 없다(서버: qwen3.5-9b) — ${ENV_HINT}`,
  ]);
  const recheck = await inspectGpuServices({ pipelineConfig, checkService: async () => SERVICE_UP, fetchModelIdList: async () => ['qwen3.5-9b'] });
  assert.equal(recheck.problemList.length, 2);
  const matched = await runPreflight({
    pipelineConfig, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', runVersion: async () => Buffer.from('ok'), checkTriggerAnalyzer: async () => [],
    checkService: async () => SERVICE_UP, fetchModelIdList: async () => [GEMMA],
  });
  assert.deepEqual(matched.problemList, []);
});

async function listen(server) {
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve) => { server.close(resolve); });
}

test('모델 목록 받기: 주소의 /v1/ 앞부분 + /v1/models 를 GET 해 data[].id 를 돌려주고, JSON 아님·data 없음·닫힌 포트는 던진다', async () => {
  const requestList = [];
  const replyByPathMap = {
    '/v1/models': [200, JSON.stringify({ object: 'list', data: [{ id: GEMMA, object: 'model' }] })],
    '/gpu/v1/models': [200, JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] })],
    '/text/v1/models': [200, 'not json'],
    '/empty/v1/models': [200, JSON.stringify({ object: 'list' })],
  };
  const server = http.createServer((request, response) => {
    requestList.push(`${request.method} ${request.url}`);
    const [statusCode, body] = replyByPathMap[request.url] ?? [404, '{"detail":"Not Found"}'];
    response.writeHead(statusCode, { 'content-type': 'application/json' });
    response.end(body);
  });
  const closedServer = net.createServer();
  const [origin, closedOrigin] = [await listen(server), await listen(closedServer)];
  await close(closedServer);
  try {
    assert.deepEqual(await fetchServedModelIdList({ url: `${origin}/v1/chat/completions` }), [GEMMA]);
    assert.deepEqual(await fetchServedModelIdList({ url: `${origin}/gpu/v1/chat/completions?x=1` }), ['a', 'b']);
    assert.deepEqual(requestList, ['GET /v1/models', 'GET /gpu/v1/models']);
    await assert.rejects(fetchServedModelIdList({ url: `${origin}/text/v1/chat/completions` }));
    await assert.rejects(fetchServedModelIdList({ url: `${origin}/empty/v1/chat/completions` }));
    await assert.rejects(fetchServedModelIdList({ url: `${origin}/missing/v1/chat/completions` }));
    await assert.rejects(fetchServedModelIdList({ url: `${closedOrigin}/v1/chat/completions` }));
  } finally {
    await close(server);
  }
});

test('시작 전 점검: 실제 GPU 서비스 점검이면 실제로 모델 목록을 받아 보고, GPU 서비스 점검을 바꿔 끼운 호출은 서버에 목록을 묻지 않는다', async () => {
  const requestList = [];
  const server = http.createServer((request, response) => {
    requestList.push(request.url);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'qwen3.5-35b-a3b' }] }));
  });
  const origin = await listen(server);
  const pipelineConfig = { vlmUrl: `${origin}/v1/chat/completions`, vlmModel: GEMMA, judgeBackend: 'bedrock', bedrockApiKey: 'token' };
  const baseArgs = { pipelineConfig, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', runVersion: async () => Buffer.from('ok'), checkTriggerAnalyzer: async () => [] };
  try {
    const real = await runPreflight(baseArgs);
    assert.deepEqual(requestList, ['/v1/chat/completions', '/v1/models']);
    assert.deepEqual(real.problemList, [`VLM 127.0.0.1:${new URL(origin).port} 에 모델 ${GEMMA} 이 없다(서버: qwen3.5-35b-a3b) — ${ENV_HINT}`]);
    requestList.length = 0;
    const faked = await runPreflight({ ...baseArgs, checkService: async () => SERVICE_UP });
    assert.deepEqual(requestList, []);
    assert.deepEqual(faked.problemList, []);
  } finally {
    await close(server);
  }
});
