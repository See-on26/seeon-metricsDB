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

// 제품 paths.js 는 저장소 안 out/ 을 가리킨다. 영상별 작업 폴더로 돌린다(index.js:45 가 OUT_DIR·CONTEXT_DIR 를 읽는다).
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
