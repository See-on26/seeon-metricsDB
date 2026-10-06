// src/product/product-paths.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 심볼릭 링크 경로(/tmp → /private/tmp 등)가 섞이면 require 캐시 키가 갈라져 같은 모듈이 두 번 로드된다. 실제 경로로 맞춘다.
export const FACTORY_ROOT = fs.realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
export const SEEON_MEET_ROOT = path.join(FACTORY_ROOT, 'seeon-meet');
export const PRODUCT_MAIN_DIR = path.join(SEEON_MEET_ROOT, 'src', 'main');

export function resolveProductPath(relativePath) {
  return path.join(SEEON_MEET_ROOT, relativePath);
}
