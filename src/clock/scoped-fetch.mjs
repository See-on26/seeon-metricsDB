import { redactUrlCredential } from '../util/redact-url-credential.mjs';

// judge 는 탐지 단계 경량 LLM 판정(통합 라우터·무발화·지시 판정)이 GPU 서버로 보낸 호출이다. Bedrock 으로 넘어간 판정은 bedrock 에 든다.
export const SERVICE_MAP = { vlm: 'vlm', judge: 'judge', asr: 'asr', tts: 'tts', embed: 'embed', bedrock: 'bedrock', other: 'other' };

const BEDROCK_HOST_PATTERN = /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/;
const BEDROCK_MODEL_PATH_PATTERN = /\/model\/([^/]+)\/converse/;
const NULL_BODY_STATUS_LIST = [204, 205, 304];
// JSON 문자열 값 안의 따옴표는 이스케이프되므로 이 토큰은 구조에만 나온다. 이미지가 든 VLM 몸통은 파싱하지 않고 거른다.
const IMAGE_PART_TOKEN = '"image_url"';

// undici 는 연결 거부·DNS·TLS 실패를 모두 'fetch failed' 로 던지고 실제 원인을 cause 에 둔다. 원인까지 붙여 기록한다.
// 이 문구는 결과 JSON·manifest 로 나가므로 주소의 사용자 정보는 지운다(undici 는 user:pass@ 주소를 그대로 문구에 담아 거부한다).
function describeFetchError(error) {
  const causeText = [error.cause?.code, error.cause?.message].filter(Boolean).join(': ');
  return redactUrlCredential(causeText ? `${error.message} (${causeText})` : error.message);
}

function toOriginPath(urlText) {
  const url = new URL(String(urlText));
  return `${url.origin}${url.pathname}`;
}

const stripUsPrefix = (modelId) => String(modelId || '').replace(/^us\./, '');

const MODEL_KEY_BY_SERVICE_MAP = { [SERVICE_MAP.vlm]: 'vlmModel', [SERVICE_MAP.judge]: 'judgeGpuModel' };

export function classifyServiceUrl({ url, pipelineConfig }) {
  const target = new URL(String(url));
  const originPath = `${target.origin}${target.pathname}`;
  // 판정 GPU 주소가 VLM 과 같으면(제품 기본값) VLM 이 먼저 맞는다. 그 경우는 classifyServiceRequest 가 몸통으로 다시 가른다.
  const serviceUrlList = [
    [pipelineConfig.vlmUrl, SERVICE_MAP.vlm], [pipelineConfig.judgeGpuUrl, SERVICE_MAP.judge], [pipelineConfig.asrUrl, SERVICE_MAP.asr],
    [pipelineConfig.ttsUrl, SERVICE_MAP.tts], [pipelineConfig.ttsLongUrl, SERVICE_MAP.tts],
    [pipelineConfig.embedUrl, SERVICE_MAP.embed],
  ];
  const matched = serviceUrlList.find(([serviceUrl]) => serviceUrl && toOriginPath(serviceUrl) === originPath);
  if (matched) {
    const service = matched[1];
    const modelKey = MODEL_KEY_BY_SERVICE_MAP[service];
    return { service, modelId: modelKey ? pipelineConfig[modelKey] ?? null : null, isVlmFallback: false };
  }
  if (BEDROCK_HOST_PATTERN.test(target.hostname)) {
    const rawModelId = target.pathname.match(BEDROCK_MODEL_PATH_PATTERN)?.[1];
    const modelId = rawModelId ? decodeURIComponent(rawModelId) : null;
    const isVlmFallback = Boolean(modelId && pipelineConfig.vlmFallbackModelId
      && stripUsPrefix(modelId) === stripUsPrefix(pipelineConfig.vlmFallbackModelId));
    return { service: SERVICE_MAP.bedrock, modelId, isVlmFallback };
  }
  return { service: SERVICE_MAP.other, modelId: null, isVlmFallback: false };
}

// 제품 judge-llm.js 는 OpenAI chat 메시지의 content 를 모두 글 한 덩어리(문자열)로 보내고, vlm-gateway.js 는 이미지가 없는
// 라벨링·질문 라우팅까지 늘 부품 목록(배열)으로 보낸다. 그래서 "이미지 없음"이 아니라 content 모양으로 판정 요청을 가린다.
export function isJudgeRequestBody(body) {
  if (typeof body !== 'string' || body.includes(IMAGE_PART_TOKEN)) return false;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  const messageList = parsed?.messages;
  return Array.isArray(messageList) && messageList.length > 0 && messageList.every((message) => typeof message?.content === 'string');
}

// URL 로 가른 뒤, 판정 GPU 주소가 VLM 주소와 같은 호출만 몸통을 보고 판정을 VLM 통계에서 떼어 낸다.
export function classifyServiceRequest({ url, body, pipelineConfig }) {
  const classified = classifyServiceUrl({ url, pipelineConfig });
  const isSharedJudgeUrl = classified.service === SERVICE_MAP.vlm && Boolean(pipelineConfig.judgeGpuUrl)
    && toOriginPath(pipelineConfig.judgeGpuUrl) === toOriginPath(url);
  if (!isSharedJudgeUrl || !isJudgeRequestBody(body)) return classified;
  return { service: SERVICE_MAP.judge, modelId: pipelineConfig.judgeGpuModel ?? null, isVlmFallback: false };
}

function computePercentile(sortedList, percent) {
  if (!sortedList.length) return null;
  return sortedList[Math.max(0, Math.ceil((percent / 100) * sortedList.length) - 1)];
}

function computeStat(recordList) {
  const sortedList = recordList.map((record) => record.elapsedMs).filter(Number.isFinite).sort((a, b) => a - b);
  return {
    count: recordList.length,
    errorCount: recordList.filter((record) => record.errorMessage || (record.status !== null && record.status >= 400)).length,
    p50Ms: computePercentile(sortedList, 50),
    p95Ms: computePercentile(sortedList, 95),
    maxMs: sortedList.length ? sortedList[sortedList.length - 1] : null,
  };
}

function groupBy(recordList, readKey) {
  const groupMap = new Map();
  for (const record of recordList) {
    const key = readKey(record);
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key).push(record);
  }
  return groupMap;
}

export function computeServiceStats({ callLog }) {
  const serviceMap = {};
  for (const [service, recordList] of groupBy(callLog, (record) => record.service)) serviceMap[service] = computeStat(recordList);
  const bedrockModelMap = {};
  const bedrockList = callLog.filter((record) => record.service === SERVICE_MAP.bedrock);
  for (const [modelId, recordList] of groupBy(bedrockList, (record) => record.modelId || 'unknown')) bedrockModelMap[modelId] = computeStat(recordList);
  return { serviceMap, bedrockModelMap };
}

// 제품 모듈 범위에 주입하는 fetch. 응답 몸통까지 받는 동안을 "외부 호출 진행 중"으로 세어 가상 시계가 1:1 로 흐르게 한다.
// 요청 헤더(토큰)는 기록하지 않는다.
export function createScopedFetch({
  clock, pipelineConfig, requestContextStorage, baseFetch = globalThis.fetch.bind(globalThis), realNow = () => performance.now(),
}) {
  const callLog = [];

  async function scopedFetch(input, init) {
    const { service, modelId, isVlmFallback } = classifyServiceRequest({ url: input, body: init?.body, pipelineConfig });
    const requestContext = requestContextStorage.getStore() || null;
    // errorName 은 시간 초과(TimeoutError)를 가르고, errorCode 는 연결 실패 원인(ECONNREFUSED 등)이다.
    const record = {
      service, modelId, isVlmFallback, status: null, errorMessage: null, errorName: null, errorCode: null,
      startedAtElapsedMs: Math.round(clock.elapsedMs()), elapsedMs: null,
      channel: requestContext?.channel ?? null, requestSeq: requestContext?.seq ?? null,
    };
    const realStartedAt = realNow();
    clock.beginExternal();
    try {
      const response = await baseFetch(input, init);
      const body = NULL_BODY_STATUS_LIST.includes(response.status) ? null : await response.arrayBuffer();
      record.status = response.status;
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      record.errorMessage = describeFetchError(error);
      record.errorName = error.name ?? null;
      record.errorCode = error.cause?.code ?? null;
      throw error;
    } finally {
      record.elapsedMs = Math.round(realNow() - realStartedAt);
      clock.endExternal();
      callLog.push(record);
      requestContext?.callList.push(record);
    }
  }

  return {
    fetch: scopedFetch,
    getCallLog: () => [...callLog],
    summarizeServiceStats: () => computeServiceStats({ callLog }),
  };
}
