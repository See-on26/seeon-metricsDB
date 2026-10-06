export const SERVICE_MAP = { vlm: 'vlm', asr: 'asr', tts: 'tts', embed: 'embed', bedrock: 'bedrock', other: 'other' };

const BEDROCK_HOST_PATTERN = /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/;
const BEDROCK_MODEL_PATH_PATTERN = /\/model\/([^/]+)\/converse/;
const NULL_BODY_STATUS_LIST = [204, 205, 304];

function toOriginPath(urlText) {
  const url = new URL(String(urlText));
  return `${url.origin}${url.pathname}`;
}

const stripUsPrefix = (modelId) => String(modelId || '').replace(/^us\./, '');

export function classifyServiceUrl({ url, pipelineConfig }) {
  const target = new URL(String(url));
  const originPath = `${target.origin}${target.pathname}`;
  const serviceUrlList = [
    [pipelineConfig.vlmUrl, SERVICE_MAP.vlm], [pipelineConfig.asrUrl, SERVICE_MAP.asr],
    [pipelineConfig.ttsUrl, SERVICE_MAP.tts], [pipelineConfig.ttsLongUrl, SERVICE_MAP.tts],
    [pipelineConfig.embedUrl, SERVICE_MAP.embed],
  ];
  const matched = serviceUrlList.find(([serviceUrl]) => serviceUrl && toOriginPath(serviceUrl) === originPath);
  if (matched) {
    const service = matched[1];
    return { service, modelId: service === SERVICE_MAP.vlm ? pipelineConfig.vlmModel : null, isVlmFallback: false };
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
    const { service, modelId, isVlmFallback } = classifyServiceUrl({ url: input, pipelineConfig });
    const requestContext = requestContextStorage.getStore() || null;
    const record = {
      service, modelId, isVlmFallback, status: null, errorMessage: null,
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
      record.errorMessage = error.message;
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
