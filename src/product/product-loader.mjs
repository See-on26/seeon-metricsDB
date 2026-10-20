// src/product/product-loader.mjs
import Module, { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT_MAIN_DIR, resolveProductPath } from './product-paths.mjs';

export const PRODUCT_SCOPE_KEY = '__seeonFactoryScope';
const SCOPE_NAME_LIST = ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'fetch'];
const ELECTRON_SHIM_PATH = fs.realpathSync(fileURLToPath(new URL('./electron-shim.cjs', import.meta.url)));
const require = createRequire(import.meta.url);

let activeScope = null;
let isInstalled = false;

// 제품 CJS 모듈 맨 앞에 붙여 시계·fetch 이름을 모듈 범위에서 가린다. 줄바꿈이 없어 오류 행 번호가 원본과 같다.
export function buildScopePrelude() {
  return `const { ${SCOPE_NAME_LIST.join(', ')} } = globalThis.${PRODUCT_SCOPE_KEY};`;
}

function readActiveScope() {
  if (!activeScope) throw new Error('제품 시계 범위가 없다 — setProductScope 를 먼저 부른다');
  return activeScope;
}

// prelude 는 모듈을 읽을 때 한 번 이름을 묶으므로, 실제 시계는 위임으로 나중에 갈아 끼울 수 있게 둔다.
function createDelegatingScope() {
  class ScopedDate extends Date {
    constructor(...argList) {
      if (argList.length) super(...argList);
      else super(readActiveScope().nowWall());
    }

    static now() {
      return readActiveScope().nowWall();
    }
  }
  return {
    Date: ScopedDate,
    performance: {
      now: () => readActiveScope().nowPerf(),
      get timeOrigin() { return readActiveScope().nowWall() - readActiveScope().nowPerf(); },
    },
    setTimeout: (...argList) => readActiveScope().setTimeout(...argList),
    clearTimeout: (handle) => readActiveScope().clearTimeout(handle),
    setInterval: (...argList) => readActiveScope().setInterval(...argList),
    clearInterval: (handle) => readActiveScope().clearInterval(handle),
    fetch: (...argList) => readActiveScope().fetch(...argList),
  };
}

export function setProductScope(scope) {
  activeScope = scope;
}

export function createProductScope({ clock, fetch }) {
  return {
    nowWall: () => clock.nowWall(),
    nowPerf: () => clock.nowPerf(),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    fetch,
  };
}

// 제품 paths.js 는 저장소 안 out/ 을 가리킨다. 영상별 작업 폴더로 돌린다(index.js:52 가 OUT_DIR·CONTEXT_DIR 를 읽는다).
function installPathsShim({ outDir }) {
  const pathsFile = require.resolve(resolveProductPath('src/main/paths.js'));
  const realPaths = require(pathsFile);
  const slidesDir = path.join(outDir, 'slides');
  require.cache[pathsFile].exports = {
    ...realPaths,
    OUT_DIR: outDir,
    FRAMES_DIR: path.join(outDir, 'frames'),
    ROI_LOG: path.join(outDir, 'roi-log.jsonl'),
    DEIXIS_FRAMES_DIR: path.join(outDir, 'deixis-frames'),
    DEIXIS_NARRATED_DIR: path.join(outDir, 'deixis-frames', '내레이션 생성'),
    DEIXIS_SKIPPED_DIR: path.join(outDir, 'deixis-frames', '내레이션 미생성'),
    SLIDES_DIR: slidesDir,
    SUMMARIES_DIR: path.join(outDir, 'summaries'),
    CONTEXT_DIR: path.join(outDir, 'context'),
    resolveSlideDir: ({ sessionId, major }) => (sessionId
      ? path.join(slidesDir, sessionId, `slide-${major}`)
      : path.join(slidesDir, `slide-${major}`)),
  };
}

// 제품 judge-llm.js 의 label → 기록 키(판정기마다 하나). 판정기는 결과에 source 를 담지만 제품 기록에는 라우터 것만 디버그 문구로 남는다.
// 통합 라우터는 판단 지시문을 두 묶음(지시 대상·발화 기반)으로 나눠 그 문장에 있는 묶음마다 한 번씩 부르고 label 을 묶음 이름으로 단다
// (router/unified-router.js judgeGroup). 두 묶음 모두 라우터의 판정 호출이라 router 하나로 센다 — 수는 판정 LLM 호출 수다.
const JUDGE_KEY_BY_LABEL_MAP = {
  '지시 대상 판단': 'router', '발화 기반 판단': 'router', '무발화 판정': 'silence', '지시 판정': 'deixis',
};
const JUDGE_SOURCE_LIST = ['gpu', 'bedrock', 'error'];
const JUDGE_ERROR_SOURCE = 'error';
const judgeSourceCountMap = Object.fromEntries([...new Set(Object.values(JUDGE_KEY_BY_LABEL_MAP))]
  .map((judgeKey) => [judgeKey, Object.fromEntries(JUDGE_SOURCE_LIST.map((source) => [source, 0]))]));

function countJudgeSource({ label, source }) {
  const judgeKey = JUDGE_KEY_BY_LABEL_MAP[label] || label;
  judgeSourceCountMap[judgeKey] ??= {};
  judgeSourceCountMap[judgeKey][source] = (judgeSourceCountMap[judgeKey][source] || 0) + 1;
}

// 판정기(router/*.js)는 읽힐 때 createJudgeLlm 을 꺼내 두므로 그보다 먼저 감싼 것으로 바꿔, 판정 호출마다 답한 곳(gpu·bedrock)과
// 실패(error)를 센다. 제품은 판정 백엔드(gpu·bedrock) 하나만 부르고 실패해도 다른 쪽으로 넘기지 않으므로 error 는 그 백엔드의 실패다.
// 판정 결과는 그대로 돌려준다. 삽입 위치 추론(output/gap-inference-agent.js)은 같은 GPU 판정 LLM 을 부르지만 이 모듈을 거치지 않아
// 여기서 세지 않는다(서비스 호출 기록 judge 와 AD 의 gap.source 에 남는다).
function installJudgeCounterShim() {
  const judgeLlmFile = require.resolve(resolveProductPath('src/main/caption-pipeline/agents/shared/judge-llm.js'));
  const realJudgeLlm = require(judgeLlmFile);
  const createCountedJudgeLlm = (option) => {
    const judgeLlm = realJudgeLlm.createJudgeLlm(option);
    async function requestText(request) {
      try {
        const result = await judgeLlm.requestText(request);
        countJudgeSource({ label: request.label, source: result.source });
        return result;
      } catch (error) {
        countJudgeSource({ label: request.label, source: JUDGE_ERROR_SOURCE });
        throw error;
      }
    }
    return { ...judgeLlm, requestText };
  };
  require.cache[judgeLlmFile].exports = { ...realJudgeLlm, createJudgeLlm: createCountedJudgeLlm };
}

export function getJudgeSourceCountMap() {
  return structuredClone(judgeSourceCountMap);
}

// 제품 index.js 가 만드는 Kiwi 형태소 분석기(trigger/kiwi-tokenizer.js)를 붙잡아 워커가 세션 전에 준비를 기다리게 한다.
// 제품 앱은 앱이 뜰 때 한 번 읽어 회의를 시작하기 전에 준비가 끝나 있다. 공장은 영상 0ms 부터 세션을 돌리므로 기다리지 않으면
// 첫 전사들이 대체 규칙(rule)으로 트리거를 뽑아 제품과 달라진다.
const kiwiTokenizerList = [];

function installKiwiTokenizerShim() {
  const kiwiTokenizerFile = require.resolve(resolveProductPath('src/main/caption-pipeline/trigger/kiwi-tokenizer.js'));
  const realKiwiTokenizer = require(kiwiTokenizerFile);
  const createTrackedKiwiTokenizer = (option) => {
    const tokenizer = realKiwiTokenizer.createKiwiTokenizer(option);
    kiwiTokenizerList.push(tokenizer);
    return tokenizer;
  };
  require.cache[kiwiTokenizerFile].exports = { ...realKiwiTokenizer, createKiwiTokenizer: createTrackedKiwiTokenizer };
}

export function getKiwiTokenizer() {
  return kiwiTokenizerList.at(-1) ?? null;
}

// 트리거가 전사마다 쓴 분석기(kiwi·rule·english) 수. 한국어 전사에 rule 이 있으면 Kiwi 없이 대체 규칙으로 뽑은 것이라 제품과 다르다.
const triggerAnalyzerCountMap = {};

function installSpeechTriggerCounterShim() {
  const speechTriggerFile = require.resolve(resolveProductPath('src/main/caption-pipeline/trigger/speech-trigger.js'));
  const realSpeechTrigger = require(speechTriggerFile);
  const createCountedSpeechTrigger = (option) => {
    const speechTrigger = realSpeechTrigger.createSpeechTrigger(option);
    function detect(input) {
      const result = speechTrigger.detect(input);
      if (result.analyzer) triggerAnalyzerCountMap[result.analyzer] = (triggerAnalyzerCountMap[result.analyzer] || 0) + 1;
      return result;
    }
    return { ...speechTrigger, detect };
  };
  require.cache[speechTriggerFile].exports = { ...realSpeechTrigger, createSpeechTrigger: createCountedSpeechTrigger };
}

export function getTriggerAnalyzerCountMap() {
  return { ...triggerAnalyzerCountMap };
}

export function installProductLoader({ outDir }) {
  if (isInstalled) throw new Error('installProductLoader 는 프로세스마다 한 번만 부른다');
  isInstalled = true;
  globalThis[PRODUCT_SCOPE_KEY] = createDelegatingScope();
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function resolveWithElectronShim(request, ...restList) {
    if (request === 'electron') return ELECTRON_SHIM_PATH;
    return originalResolve.call(this, request, ...restList);
  };
  const originalCompile = Module.prototype._compile;
  const prelude = buildScopePrelude();
  const productPrefix = `${PRODUCT_MAIN_DIR}${path.sep}`;
  Module.prototype._compile = function compileWithScope(content, filename, ...restList) {
    const scopedContent = filename.startsWith(productPrefix) ? `${prelude}${content}` : content;
    return originalCompile.call(this, scopedContent, filename, ...restList);
  };
  installPathsShim({ outDir });
  installJudgeCounterShim();
  installKiwiTokenizerShim();
  installSpeechTriggerCounterShim();
}

export function loadRegisterPipeline() {
  return require(resolveProductPath('src/main/caption-pipeline/index.js'));
}

export function loadPipelineConfig() {
  return require(resolveProductPath('src/main/caption-pipeline/config.js'));
}

export function getIpcRegistry() {
  return require(ELECTRON_SHIM_PATH).getIpcRegistry();
}
