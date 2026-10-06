// src/product/product-version.mjs
import { execFileSync } from 'node:child_process';
import { SEEON_MEET_ROOT } from './product-paths.mjs';

// 결과가 어느 제품 커밋으로 만들어졌는지 남긴다. git 이 없거나 실패하면 null.
export function readSeeonMeetVersion() {
  try {
    const commit = execFileSync('git', ['-C', SEEON_MEET_ROOT, 'rev-parse', 'HEAD']).toString().trim();
    const isDirty = execFileSync('git', ['-C', SEEON_MEET_ROOT, 'status', '--porcelain']).toString().trim().length > 0;
    return { commit, isDirty };
  } catch {
    return { commit: null, isDirty: null };
  }
}
