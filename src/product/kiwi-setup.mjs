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

// 제품은 한국어 전사의 지시 트리거를 Kiwi 형태소 분석으로 뽑는다. 개발 실행(설치본이 아님)은 seeon-meet/vendor/kiwi-model 의 모델과
// 제품 의존성 kiwi-nlp(wasm)를 쓴다(kiwi-model.js resolveKiwiModelDir). 공장 워커도 electron app 이 없어 같은 경로를 쓴다.
// 하나라도 없으면 제품이 대체 규칙으로 떨어져 결과가 달라지므로 시작 전 점검에서 막는다. 모델을 실제로 읽지는 않는다(1초·수백 MB).
// 모델 확인은 제품 설치 도구(setup:kiwi)의 isModelReady(파일 다섯 개 + VERSION)를 그대로 쓴다. 제품 모듈은 부를 때 읽어,
// 워커가 이 파일을 가져와도 시계 범위(prelude)를 깔기 전에 제품 모듈이 캐시되지 않게 한다.
export async function checkKiwiSetup() {
  const problemList = [];
  try {
    createRequire(resolveProductPath(KIWI_TOKENIZER_PATH)).resolve('kiwi-nlp/dist/kiwi-wasm.wasm');
  } catch {
    problemList.push(`한국어 트리거 형태소 분석기 의존성 kiwi-nlp 를 seeon-meet 에서 찾지 못했다 — ${KIWI_PACKAGE_HINT}`);
  }
  const { isModelReady } = await import(pathToFileURL(resolveProductPath(KIWI_FETCH_TOOL_PATH)).href);
  const { resolveKiwiModelDir, KIWI_MODEL_VERSION } = require(resolveProductPath(KIWI_MODEL_PATH));
  const modelDir = resolveKiwiModelDir({ isPackaged: false });
  if (!isModelReady({ modelDir })) {
    problemList.push(`한국어 트리거 형태소 분석 모델(Kiwi ${KIWI_MODEL_VERSION})이 없다(${modelDir}) — ${KIWI_MODEL_HINT}`);
  }
  return problemList;
}
