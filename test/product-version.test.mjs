import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readSeeonMeetVersion } from '../src/product/product-version.mjs';
import { SEEON_MEET_ROOT } from '../src/product/product-paths.mjs';

test('제품 버전: 서브모듈 seeon-meet 의 HEAD 커밋과 수정 여부를 읽는다', () => {
  const { commit, isDirty } = readSeeonMeetVersion();
  assert.equal(commit, execFileSync('git', ['-C', SEEON_MEET_ROOT, 'rev-parse', 'HEAD']).toString().trim());
  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.equal(typeof isDirty, 'boolean');
});
