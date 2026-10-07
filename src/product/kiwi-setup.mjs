// src/product/kiwi-setup.mjs
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolveProductPath } from './product-paths.mjs';

const require = createRequire(import.meta.url);
const KIWI_MODEL_PATH = 'src/main/caption-pipeline/trigger/kiwi-model.js';
const KIWI_TOKENIZER_PATH = 'src/main/caption-pipeline/trigger/kiwi-tokenizer.js';
const KIWI_FETCH_TOOL_PATH = 'tools/kiwi/fetch-kiwi-model.mjs';
export const KIWI_PACKAGE_HINT = 'npm --prefix seeon-meet ci --omit=dev';
export const KIWI_MODEL_HINT = 'npm --prefix seeon-meet run setup:kiwi';
const SUBMODULE_HINT = 'git submodule update --init';

// 제품과 같은 방법으로 kiwi-nlp 의 wasm 경로를 찾는다(kiwi-tokenizer.js resolveKiwiWasmPath).
const resolveProductKiwiWasm = () => createRequire(resolveProductPath(KIWI_TOKENIZER_PATH)).resolve('kiwi-nlp/dist/kiwi-wasm.wasm');

// 제품 모듈은 부를 때 읽어, 워커가 이 파일을 가져와도 시계 범위(prelude)를 깔기 전에 제품 모듈이 캐시되지 않게 한다.
async function loadProductKiwiModule() {
  const { isModelReady } = await import(pathToFileURL(resolveProductPath(KIWI_FETCH_TOOL_PATH)).href);
  const { resolveKiwiModelDir, KIWI_MODEL_VERSION } = require(resolveProductPath(KIWI_MODEL_PATH));
  return { isModelReady, resolveKiwiModelDir, KIWI_MODEL_VERSION };
}

// 제품은 한국어 전사의 지시 트리거를 Kiwi 형태소 분석으로 뽑는다. 개발 실행(설치본이 아님)은 seeon-meet/vendor/kiwi-model 의 모델과
// 제품 의존성 kiwi-nlp(wasm)를 쓴다(kiwi-model.js resolveKiwiModelDir). 공장 워커도 electron app 이 없어 같은 경로를 쓴다.
// 하나라도 없으면 제품이 대체 규칙으로 떨어져 결과가 달라지므로 시작 전 점검·npm test 앞에서 막는다. 모델을 실제로 읽지는 않는다(1초·수백 MB).
// 모델 확인은 제품 설치 도구(setup:kiwi)의 isModelReady(파일 다섯 개 + VERSION)를 그대로 쓴다.
// modelDir·resolveKiwiWasm 은 시험이 없는 모델·의존성을 흉내 내려고 바꿔 끼운다.
export async function checkKiwiSetup({ modelDir = null, resolveKiwiWasm = resolveProductKiwiWasm } = {}) {
  let productKiwi = null;
  try {
    productKiwi = await loadProductKiwiModule();
  } catch (error) {
    return [`seeon-meet 의 Kiwi 모듈을 읽지 못했다(${error.message.split('\n')[0]}) — ${SUBMODULE_HINT}`];
  }
  const problemList = [];
  try {
    resolveKiwiWasm();
  } catch {
    problemList.push(`한국어 트리거 형태소 분석기 의존성 kiwi-nlp 를 seeon-meet 에서 찾지 못했다 — ${KIWI_PACKAGE_HINT}`);
  }
  const checkedModelDir = modelDir ?? productKiwi.resolveKiwiModelDir({ isPackaged: false });
  if (!productKiwi.isModelReady({ modelDir: checkedModelDir })) {
    problemList.push(`한국어 트리거 형태소 분석 모델(Kiwi ${productKiwi.KIWI_MODEL_VERSION})이 없다(${checkedModelDir}) — ${KIWI_MODEL_HINT}`);
  }
  return problemList;
}

// 제품 앱은 시작할 때 Kiwi 형태소 분석기를 읽어 회의 전에 준비가 끝난다. 워커는 세션을 시작하기 전에 같은 준비를 기다린다.
// 못 띄우면 한국어 트리거가 대체 규칙으로 떨어져 제품과 달라지므로 원인과 설치 명령을 담아 영상을 실패로 끝낸다.
export async function waitKiwiReady({ tokenizer }) {
  if (!tokenizer) throw new Error('제품 파이프라인이 Kiwi 형태소 분석기를 만들지 않았다');
  try {
    await tokenizer.load();
  } catch (error) {
    throw new Error(`한국어 트리거 형태소 분석기(Kiwi)를 띄우지 못했다(${error.message}) — ${KIWI_PACKAGE_HINT} · ${KIWI_MODEL_HINT}`);
  }
}

// npm test 앞(pretest)에서 한 번 점검해, 시험 파일마다 흩어진 실패 대신 준비 명령을 한 번에 보여 주고 멈춘다.
// Kiwi 없이 건너뛰면 제품의 한국어 트리거 경로를 시험하지 않은 채 통과하므로 건너뛰지 않는다.
export function buildTestSetupMessage(problemList) {
  return [
    '[pretest] npm test 준비물이 없다 — 제품 파이프라인을 세우는 시험이 Kiwi 를 띄우므로 건너뛰지 않고 멈춘다',
    ...problemList.map((problem) => `  - ${problem}`),
    `  준비: ${KIWI_PACKAGE_HINT} && ${KIWI_MODEL_HINT}`,
  ].join('\n');
}
