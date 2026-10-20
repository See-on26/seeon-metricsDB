// src/runner/preflight.mjs
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import { runBinary } from '../media/ffmpeg.mjs';
import { resolveProductPath } from '../product/product-paths.mjs';
import { checkKiwiSetup } from '../product/kiwi-setup.mjs';
import { GAP_CANDIDATE_SOURCE_MAP } from '../product/core-modules.mjs';

const require = createRequire(import.meta.url);
const TUNNEL_POLL_MS = 200;
const TUNNEL_CONFIG_PATH = 'src/main/gpu-tunnel/tunnel-config.js';
const GPU_TUNNEL_PATH = 'src/main/gpu-tunnel/gpu-tunnel.js';
const TUNNEL_STATUS_PATH = 'src/main/gpu-tunnel/tunnel-status.js';
const DEFAULT_PORT_BY_PROTOCOL_MAP = { 'http:': 80, 'https:': 443 };

const HTTP_MODULE_BY_PROTOCOL_MAP = { 'http:': http, 'https:': https };
const PROBE_TIMEOUT_MS = 3000;
const PROBE_FAILURE_LABEL_MAP = {
  ECONNREFUSED: '연결 거부', ECONNRESET: '연결이 끊김', EHOSTUNREACH: '호스트에 닿지 못함', ENETUNREACH: '네트워크에 닿지 못함',
  ENOTFOUND: '호스트 이름을 찾지 못함', ETIMEDOUT: '연결 시간 초과',
};

function describeProbeError(error) {
  const label = PROBE_FAILURE_LABEL_MAP[error.code];
  if (label) return `${label}(${error.code})`;
  return error.code ? `${error.code}: ${error.message}` : error.message;
}

// GPU 서비스가 HTTP 로 답하는지 본다. 상태 코드와 상관없이 응답이 오면 서버가 살아 있다(경로·메서드가 달라 405·404 를 주는 서버가 많다).
// 연결 거부·끊김·응답 없음은 죽은 것이다. SSH 터널은 원격 서비스가 죽어도 로컬 포트를 열어 두므로 TCP 연결만으로는 알 수 없다.
// 몸통 없는 GET 이라 모델을 돌리지 않고, 연결을 남기지 않는다.
export function probeHttpService({ url, timeoutMs = PROBE_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const target = new URL(url);
    const httpModule = HTTP_MODULE_BY_PROTOCOL_MAP[target.protocol];
    if (!httpModule) {
      resolve({ isUp: false, detail: `HTTP 주소가 아니다(${target.protocol})` });
      return;
    }
    let isSettled = false;
    const request = httpModule.request(target, { method: 'GET', timeout: timeoutMs, agent: false }, (response) => {
      response.resume();
      finish({ isUp: true, detail: `HTTP ${response.statusCode}` });
    });
    function finish(result) {
      if (isSettled) return;
      isSettled = true;
      request.destroy();
      resolve(result);
    }
    request.on('timeout', () => finish({ isUp: false, detail: `응답 없음(${timeoutMs / 1000}초)` }));
    request.on('error', (error) => finish({ isUp: false, detail: describeProbeError(error) }));
    request.end();
  });
}

// 슬라이드 전사 OCR 점검에 보내는 흰 64×32 JPEG(234바이트). 글자가 없어 엔진은 빈 줄 목록으로 곧바로 답한다.
const OCR_PROBE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjExLjEwMAD/2wBDAAgKCgsKCw0NDQ0NDRAPEBAQEBAQEBAQEBASEhIVFRUSEhIQEBISFBQVFRcXFxUVFRUXFxkZGR4eHBwjIyQrKzP/'
  + 'xABMAAEBAAAAAAAAAAAAAAAAAAAABwEBAQAAAAAAAAAAAAAAAAAAAAEQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAgAEADASIAAhEAAxEA/9oADAMBAAIRAxEA'
  + 'PwC/gIgAAAAAAAAAAAAAD//Z',
  'base64',
);
// 제품 ocr-client.js 의 요청 상한(5초)과 같다.
const OCR_PROBE_TIMEOUT_MS = 5000;
const OCR_PROBE_DETAIL_MAX_LENGTH = 160;
const OCR_STATUS_HINT_MAP = {
  404: '/ocr 경로가 없다(OCR 이 없는 GPU 서버)', 405: '/ocr 경로가 없다(OCR 이 없는 GPU 서버)', 503: 'OCR 엔진이 없다(GPU 서버 setup-embed.sh·fetch-ocr-models.sh)',
};

// 제품 ocr-client.js isOcrResponse 와 같은 응답 모양.
function isOcrResponseBody(body) {
  return Boolean(body) && typeof body.text === 'string'
    && Array.isArray(body.lineList) && body.lineList.every((line) => Boolean(line) && typeof line.text === 'string')
    && Number.isFinite(body.meanScore) && Number.isFinite(body.verticalBoxRatio);
}

function describeOcrFailure({ statusCode, bodyText }) {
  let serverDetail = '';
  try {
    serverDetail = String(JSON.parse(bodyText)?.detail ?? '').slice(0, OCR_PROBE_DETAIL_MAX_LENGTH);
  } catch {
    serverDetail = '';
  }
  return [`HTTP ${statusCode}`, OCR_STATUS_HINT_MAP[statusCode], serverDetail].filter(Boolean).join(' — ');
}

// 슬라이드 전사 OCR(/ocr)이 실제로 전사하는지 작은 JPEG 한 장을 POST 해 본다. GPU 서비스 점검처럼 응답만 보면 /ocr 이 없는 서버(404)·
// OCR 엔진이 없는 서버(503)도 살아 있다고 보게 되고, 그대로 돌리면 제품이 장마다 VLM 으로 넘겨 결과는 ocr 이라 적힌 채 VLM 으로 전사된다.
// 2xx 와 제품이 읽는 응답 모양일 때만 통과다. isReachable 은 HTTP 응답이 왔는지다 — 연결 거부·끊김·응답 없음(GPU 서비스 점검과 같은 문구)만
// false 이고, 터널을 열면 고쳐질 수 있는 것은 이쪽뿐이다. HTTP 로 답했는데 실패(상태 코드·모양)한 것은 GPU 서버의 OCR 문제다.
export function probeOcrService({ url, timeoutMs = OCR_PROBE_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const target = new URL(url);
    const httpModule = HTTP_MODULE_BY_PROTOCOL_MAP[target.protocol];
    if (!httpModule) {
      resolve({ isUp: false, isReachable: false, detail: `HTTP 주소가 아니다(${target.protocol})` });
      return;
    }
    let isSettled = false;
    const request = httpModule.request(target, {
      method: 'POST', timeout: timeoutMs, agent: false,
      headers: { 'content-type': 'image/jpeg', 'content-length': OCR_PROBE_JPEG.length },
    }, (response) => {
      const chunkList = [];
      response.on('data', (chunk) => chunkList.push(chunk));
      response.on('end', () => {
        const bodyText = Buffer.concat(chunkList).toString('utf8');
        const { statusCode } = response;
        if (statusCode < 200 || statusCode >= 300) {
          finish({ isUp: false, isReachable: true, detail: describeOcrFailure({ statusCode, bodyText }) });
          return;
        }
        let body = null;
        try {
          body = JSON.parse(bodyText);
        } catch {
          body = null;
        }
        finish(isOcrResponseBody(body)
          ? { isUp: true, isReachable: true, detail: `HTTP ${statusCode}` }
          : { isUp: false, isReachable: true, detail: `HTTP ${statusCode} 이지만 OCR 응답 모양이 아니다` });
      });
      response.on('error', (error) => finish({ isUp: false, isReachable: false, detail: describeProbeError(error) }));
    });
    function finish(result) {
      if (isSettled) return;
      isSettled = true;
      request.destroy();
      resolve(result);
    }
    request.on('timeout', () => finish({ isUp: false, isReachable: false, detail: `응답 없음(${timeoutMs / 1000}초)` }));
    request.on('error', (error) => finish({ isUp: false, isReachable: false, detail: describeProbeError(error) }));
    request.end(OCR_PROBE_JPEG);
  });
}

// 제품 config.js SLIDE_TEXT_BACKEND_LIST 의 ocr.
const SLIDE_TEXT_BACKEND_OCR = 'ocr';

// 제품 tunnel-config.js 의 FORWARD_URL_KEY_LIST 와 같은 GPU 서비스 주소들(긴 문장 TTS 포함). 탐지 판정 GPU 주소(judgeGpuUrl)는
// 판정 백엔드가 gpu 일 때만 쓰므로 따로 둔다(listServiceUrlKeyList).
const GPU_SERVICE_URL_KEY_LIST = [['VLM', 'vlmUrl'], ['ASR', 'asrUrl'], ['TTS', 'ttsUrl'], ['TTS_LONG', 'ttsLongUrl'], ['EMBED', 'embedUrl']];
const JUDGE_URL_KEY = ['JUDGE', 'judgeGpuUrl'];
// 제품 judge-llm.js JUDGE_BACKEND_MAP 과 같은 값.
const JUDGE_BACKEND_MAP = { gpu: 'gpu', bedrock: 'bedrock' };
// Bedrock 토큰이 없을 때 제품과 달라지는 곳. gpu 판정은 토큰 없이도 돌지만 GPU 가 실패하면 Bedrock 으로 넘기지 못한다.
const MISSING_BEDROCK_KEY_IMPACT_BY_BACKEND_MAP = {
  [JUDGE_BACKEND_MAP.gpu]: '틈 추론이 규칙 폴백으로 떨어지고 GPU 판정이 실패해도 Bedrock 으로 넘기지 못해',
  [JUDGE_BACKEND_MAP.bedrock]: 'SEEON_JUDGE_BACKEND=bedrock 이라 판단 LLM(라우터·무발화 판정)을 쓸 수 없어 발화 기반·무발화 해설이 나오지 않고 틈 추론이 규칙 폴백으로 떨어져',
};

function readHostPort(url) {
  const { hostname, port, protocol } = new URL(url);
  return { hostname, portNumber: Number(port) || DEFAULT_PORT_BY_PROTOCOL_MAP[protocol] };
}

// 제품 기본 판정 GPU 주소는 VLM(8801)과 따로 띄운 판정 LLM(127.0.0.1:8805)이라 판정 백엔드가 gpu 면 그 주소(JUDGE)도 본다.
// SEEON_JUDGE_GPU_URL 로 VLM 과 같은 호스트·포트를 주면 VLM 점검이 판정도 덮는다. 제품 터널은 판정 주소도 넘긴다(tunnel-config.js).
function listServiceUrlKeyList({ pipelineConfig }) {
  const { judgeBackend, judgeGpuUrl, vlmUrl } = pipelineConfig;
  if (judgeBackend !== JUDGE_BACKEND_MAP.gpu || !judgeGpuUrl) return GPU_SERVICE_URL_KEY_LIST;
  const judgeHostPort = readHostPort(judgeGpuUrl);
  const vlmHostPort = vlmUrl ? readHostPort(vlmUrl) : null;
  const isSameHostPort = vlmHostPort?.hostname === judgeHostPort.hostname && vlmHostPort?.portNumber === judgeHostPort.portNumber;
  return isSameHostPort ? GPU_SERVICE_URL_KEY_LIST : [...GPU_SERVICE_URL_KEY_LIST, JUDGE_URL_KEY];
}

// GPU 서비스 주소마다 HTTP 로 답하는지 보고, 답하지 않는 것만 '<이름> <호스트>:<포트> <이유>' 로 돌려준다.
// 포트를 적지 않은 주소는 프로토콜 기본 포트로 적는다. 설정에 없는 주소는 건너뛴다.
export async function listDownServices({ pipelineConfig, checkService = probeHttpService }) {
  const downServiceList = [];
  for (const [label, key] of listServiceUrlKeyList({ pipelineConfig })) {
    const url = pipelineConfig[key];
    if (!url) continue;
    const { isUp, detail } = await checkService({ url });
    if (isUp) continue;
    const { hostname, portNumber } = readHostPort(url);
    downServiceList.push(`${label} ${hostname}:${portNumber} ${detail}`);
  }
  return downServiceList;
}

// 슬라이드 전사 백엔드가 ocr 이면 OCR 주소(제품 터널도 넘긴다)가 실제로 전사하는지 본다. 닿지 않으면(연결 거부·끊김·응답 없음)
// 터널로 고쳐질 수 있어 downServiceList 로, 닿았지만 실패하면(HTTP 404·503·모양 다름) 터널로 고칠 수 없어 problemList 로 바로 낸다.
async function inspectOcrBackend({ pipelineConfig, checkOcrService }) {
  if (pipelineConfig.slideTextBackend !== SLIDE_TEXT_BACKEND_OCR) return { downServiceList: [], problemList: [] };
  const { ocrUrl } = pipelineConfig;
  if (!ocrUrl) return { downServiceList: [], problemList: ['OCR 주소가 없다(SEEON_OCR_URL 또는 SEEON_EMBED_URL 확인)'] };
  const { isUp, isReachable, detail } = await checkOcrService({ url: ocrUrl });
  if (isUp) return { downServiceList: [], problemList: [] };
  const { hostname, portNumber } = readHostPort(ocrUrl);
  const label = `OCR ${hostname}:${portNumber}`;
  if (!isReachable) return { downServiceList: [`${label} ${detail}`], problemList: [] };
  return {
    downServiceList: [],
    problemList: [`${label} 에 닿았지만 실패했다(${detail}) — 터널로 고칠 수 없다. GPU 서버의 OCR 을 확인하거나 SEEON_SLIDE_TEXT_BACKEND 를 지운다`],
  };
}

const MODEL_NAME_ENV_HINT = '.env 의 SEEON_VLM_MODEL·SEEON_JUDGE_GPU_MODEL 을 확인한다';

// 서비스 주소의 /v1/ 앞부분(앞에 붙인 프록시 경로 포함)에 /v1/models 를 붙인다. /v1/ 이 없으면 origin 바로 아래로 본다.
// 사용자 정보(user:pass@)는 그대로 둬 같은 서버에 같은 자격으로 묻는다.
function buildModelListUrl(url) {
  const target = new URL(url);
  const v1Index = target.pathname.indexOf('/v1/');
  target.pathname = `${v1Index >= 0 ? target.pathname.slice(0, v1Index) : ''}/v1/models`;
  target.search = '';
  target.hash = '';
  return target;
}

// OpenAI 호환 서버(vLLM 등)가 서빙하는 모델 이름 목록(/v1/models 의 data[].id)을 받는다.
// 닿지 않거나(연결 거부·끊김·응답 없음) 2xx 가 아니거나 JSON·data 배열이 아니면 던진다.
export function fetchServedModelIdList({ url, timeoutMs = PROBE_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const target = buildModelListUrl(url);
    const httpModule = HTTP_MODULE_BY_PROTOCOL_MAP[target.protocol];
    if (!httpModule) {
      reject(new Error(`HTTP 주소가 아니다(${target.protocol})`));
      return;
    }
    let isSettled = false;
    const request = httpModule.request(target, { method: 'GET', timeout: timeoutMs, agent: false }, (response) => {
      const chunkList = [];
      response.on('data', (chunk) => chunkList.push(chunk));
      response.on('end', () => {
        const { statusCode } = response;
        if (statusCode < 200 || statusCode >= 300) {
          finish({ error: new Error(`HTTP ${statusCode}`) });
          return;
        }
        let body = null;
        try {
          body = JSON.parse(Buffer.concat(chunkList).toString('utf8'));
        } catch {
          body = null;
        }
        if (!Array.isArray(body?.data)) {
          finish({ error: new Error(`HTTP ${statusCode} 이지만 모델 목록 모양이 아니다`) });
          return;
        }
        finish({ modelIdList: body.data.map((model) => model?.id).filter((id) => typeof id === 'string') });
      });
      response.on('error', (error) => finish({ error: new Error(describeProbeError(error)) }));
    });
    function finish({ error = null, modelIdList = null }) {
      if (isSettled) return;
      isSettled = true;
      request.destroy();
      if (error) reject(error);
      else resolve(modelIdList);
    }
    request.on('timeout', () => finish({ error: new Error(`응답 없음(${timeoutMs / 1000}초)`) }));
    request.on('error', (error) => finish({ error: new Error(describeProbeError(error)) }));
    request.end();
  });
}

// 이름을 볼 자리. 판정 주소는 listServiceUrlKeyList 처럼 판정 백엔드가 gpu 이고 주소가 있을 때만 쓴다. 주소·이름이 빈 자리는 볼 수 없어 뺀다.
function listModelNameTargetList({ pipelineConfig }) {
  const { vlmUrl, vlmModel, judgeBackend, judgeGpuUrl, judgeGpuModel } = pipelineConfig;
  const targetList = [{ label: 'VLM', url: vlmUrl, modelName: vlmModel }];
  if (judgeBackend === JUDGE_BACKEND_MAP.gpu && judgeGpuUrl) targetList.push({ label: '판정', url: judgeGpuUrl, modelName: judgeGpuModel });
  return targetList.filter(({ url, modelName }) => url && modelName);
}

// 받지 못한 목록(던짐·배열 아님)은 null 로 돌려 그 자리를 건너뛰게 한다.
async function readModelIdList({ url, fetchModelIdList }) {
  try {
    const modelIdList = await fetchModelIdList({ url });
    return Array.isArray(modelIdList) ? modelIdList : null;
  } catch {
    return null;
  }
}

// GPU 서버가 설정한 모델 이름(VLM·판정)을 서빙하는지 본다. HTTP 로 답하는지만 보면 .env 에 옛 이름이 남아도 통과하고,
// 실제 요청이 404 로 실패해 AD 가 빠지거나 Bedrock 으로 넘어간다. 같은 호스트·포트는 목록을 한 번만 받아 두 이름을 함께 본다.
// 목록을 받지 못한 자리는 건너뛴다 — 닿지 않는 것은 listDownServices 가 잡는다.
export async function listModelNameProblems({ pipelineConfig, fetchModelIdList = fetchServedModelIdList }) {
  const modelIdListByHostPortMap = new Map();
  const problemList = [];
  for (const { label, url, modelName } of listModelNameTargetList({ pipelineConfig })) {
    const { hostname, portNumber } = readHostPort(url);
    const hostPort = `${hostname}:${portNumber}`;
    if (!modelIdListByHostPortMap.has(hostPort)) modelIdListByHostPortMap.set(hostPort, await readModelIdList({ url, fetchModelIdList }));
    const modelIdList = modelIdListByHostPortMap.get(hostPort);
    if (!modelIdList || modelIdList.includes(modelName)) continue;
    problemList.push(`${label} ${hostPort} 에 모델 ${modelName} 이 없다(서버: ${modelIdList.join(', ') || '없음'}) — ${MODEL_NAME_ENV_HINT}`);
  }
  return problemList;
}

// 이름 확인의 기본은 실제 목록 받기다. 다만 GPU 서비스 점검(checkService)을 바꿔 끼운 호출(시험·대역)은 이름 확인도 서버에 보내지 않는다 —
// 그대로 두면 대역으로 돌린 점검이 열린 터널 너머 실제 GPU 서버에 묻고, 그 서버가 서빙하는 이름에 따라 결과가 바뀐다.
const pickDefaultModelIdListFetcher = (checkService) => (checkService === probeHttpService ? fetchServedModelIdList : null);

// GPU 서비스와 (ocr 백엔드면) OCR, 서빙 모델 이름을 함께 본다. 시작 전 점검과 터널을 연 뒤 다시 볼 때 같이 쓴다.
// downServiceList 는 닿지 않는 것(터널 대상), problemList 는 닿았지만 OCR 이 실패했거나 설정한 모델 이름을 서빙하지 않는 것이다.
// 터널을 열기 전에 닿지 않던 서버의 이름은 터널을 연 뒤 다시 볼 때 확인된다.
export async function inspectGpuServices({
  pipelineConfig, checkService = probeHttpService, checkOcrService = probeOcrService,
  fetchModelIdList = pickDefaultModelIdListFetcher(checkService),
}) {
  const downServiceList = await listDownServices({ pipelineConfig, checkService });
  const ocr = await inspectOcrBackend({ pipelineConfig, checkOcrService });
  const modelNameProblemList = fetchModelIdList ? await listModelNameProblems({ pipelineConfig, fetchModelIdList }) : [];
  return { downServiceList: [...downServiceList, ...ocr.downServiceList], problemList: [...ocr.problemList, ...modelNameProblemList] };
}

// Bedrock 은 호출마다 돈이 들어 점검하지 않는다(토큰이 있는지만 본다). 토큰 만료는 영상 결과의 불완전 사유(bedrock_auth_failed)로 잡힌다.
// 한국어 트리거 형태소 분석기(Kiwi)의 의존성·모델이 seeon-meet 에 있는지도 본다(checkTriggerAnalyzer, 테스트는 대역).
// 틈 후보를 잰 무음에서 고르는 audio(SEEON_GAP_SOURCE=audio)는 공장이 아직 옮기지 않았다. 그대로 돌리면 결과 설정에 audio 라고
// 적힌 채 ASR 끝 시각 후보로 돌므로 시작 전에 멈춘다.
// GPU 서버가 설정한 모델 이름(SEEON_VLM_MODEL·SEEON_JUDGE_GPU_MODEL)을 서빙하지 않아도 멈춘다(inspectGpuServices, fetchModelIdList 는 시험이 바꿔 끼운다).
export async function runPreflight({
  pipelineConfig, ffmpegPath, ffprobePath, checkService = probeHttpService, checkOcrService = probeOcrService,
  fetchModelIdList = pickDefaultModelIdListFetcher(checkService),
  runVersion = (binaryPath) => runBinary({ binaryPath, argList: ['-version'] }), checkTriggerAnalyzer = checkKiwiSetup,
}) {
  const problemList = [];
  const gapSource = pipelineConfig.gapSource ?? GAP_CANDIDATE_SOURCE_MAP.asr;
  if (gapSource !== GAP_CANDIDATE_SOURCE_MAP.asr) {
    problemList.push(`SEEON_GAP_SOURCE=${gapSource} 는 공장이 아직 지원하지 않는다 — 공장은 ASR 끝 시각 틈 후보(asr)만 옮겼다. SEEON_GAP_SOURCE 를 지우거나 asr 로 둔다`);
  }
  for (const [label, binaryPath] of [['ffmpeg', ffmpegPath], ['ffprobe', ffprobePath]]) {
    try {
      await runVersion(binaryPath);
    } catch {
      problemList.push(`${label} 를 실행하지 못했다(${binaryPath}) — 설치하거나 SEEON_FACTORY_FFMPEG·SEEON_FACTORY_FFPROBE 로 경로를 준다`);
    }
  }
  problemList.push(...await checkTriggerAnalyzer());
  const { downServiceList, problemList: serviceProblemList } = await inspectGpuServices({ pipelineConfig, checkService, checkOcrService, fetchModelIdList });
  problemList.push(...serviceProblemList);
  if (!pipelineConfig.bedrockApiKey) {
    // 백엔드가 없는 설정은 제품 judge-llm.js 처럼 Bedrock 판정으로 본다.
    const impact = MISSING_BEDROCK_KEY_IMPACT_BY_BACKEND_MAP[pipelineConfig.judgeBackend]
      ?? MISSING_BEDROCK_KEY_IMPACT_BY_BACKEND_MAP[JUDGE_BACKEND_MAP.bedrock];
    problemList.push(`AWS_BEARER_TOKEN_BEDROCK 이 없다 — ${impact} 제품과 다르게 돈다(.env 확인)`);
  }
  return { problemList, downServiceList };
}

const GIB = 1024 ** 3;
// 워커 하나가 쓰는 메모리의 대략. 제품 Kiwi 형태소 분석기만 약 0.85GB(실측 RSS 증가)이고 나머지 파이프라인·ffmpeg 를 더해 1GB 로 잡는다.
const WORKER_MEMORY_BYTES = GIB;

// 남은 메모리가 동시에 돌 워커 수 × 1GB 보다 적으면 경고 문구를 돌려준다(없으면 null). 실패로 만들지는 않는다 —
// macOS 의 os.freemem 은 캐시를 빼고 세어 실제 여유보다 작게 보일 수 있고, 동시 수는 사용자가 정한 값이다.
export function buildMemoryWarning({ workerCount, freeBytes }) {
  if (!(workerCount > 0) || freeBytes >= workerCount * WORKER_MEMORY_BYTES) return null;
  return `[factory] ⚠ 남은 메모리 ${(freeBytes / GIB).toFixed(1)}GB 가 동시에 돌 워커 ${workerCount}개 × 1GB 보다 적다`
    + ' — 워커마다 한국어 트리거 형태소 분석기(Kiwi)로 약 0.85GB 를 더 쓴다. 느려지거나 메모리가 모자라면 --concurrency 를 낮춘다';
}

// 제품 gpu-tunnel.js 는 ssh2 를 연결할 때에야 불러오므로, 로컬 포트를 열기 전에 ssh2 가 제품 쪽에 깔려 있는지 먼저 본다.
function loadProductTunnelFactory() {
  const gpuTunnelPath = resolveProductPath(GPU_TUNNEL_PATH);
  try {
    createRequire(gpuTunnelPath).resolve('ssh2');
    return require(gpuTunnelPath).createGpuTunnel;
  } catch (error) {
    throw new Error(`제품 GPU 터널 모듈을 불러오지 못했다(${error.message.split('\n')[0]}) — npm --prefix seeon-meet ci --omit=dev`);
  }
}

// GPU 서비스가 답하지 않으면 제품의 터널 모듈로 직접 연다(ssh2 는 `npm --prefix seeon-meet ci --omit=dev` 로 설치). 실행 동안 CLI 프로세스가 붙잡는다.
// 제품 index.js 는 electron app 을 읽으므로 쓰지 않고 tunnel-config.js·gpu-tunnel.js 를 바로 쓴다.
export async function startProductTunnel({ env, pipelineConfig, waitMs = 20000, pollMs = TUNNEL_POLL_MS, createTunnel = null }) {
  const { readTunnelConfig, buildForwardList, TUNNEL_MODE_MAP } = require(resolveProductPath(TUNNEL_CONFIG_PATH));
  const { TUNNEL_STATUS_MAP, describeTunnelStatus } = require(resolveProductPath(TUNNEL_STATUS_PATH));
  // 다른 터널이 이미 포트를 쥐고 있으면(external) 그 터널로 닿는다.
  const readyStatusList = [TUNNEL_STATUS_MAP.connected, TUNNEL_STATUS_MAP.external];
  const tunnelConfig = readTunnelConfig({ env });
  if (tunnelConfig.mode === TUNNEL_MODE_MAP.off || !tunnelConfig.keyPath) return null;
  const tunnel = (createTunnel || loadProductTunnelFactory())({ tunnelConfig, forwardList: buildForwardList({ pipelineConfig }) });
  try {
    await tunnel.start();
    for (let waitedMs = 0; waitedMs < waitMs; waitedMs += pollMs) {
      if (readyStatusList.includes(tunnel.getStatus().status)) return tunnel;
      await new Promise((resolve) => { setTimeout(resolve, pollMs); });
    }
    throw new Error(`GPU 터널이 제때 연결되지 않았다 — 마지막 상태: ${describeTunnelStatus(tunnel.getStatus())}`);
  } catch (error) {
    await tunnel.stop();
    throw error;
  }
}
