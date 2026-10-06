import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildOutputPathMap } from '../src/runner/output-paths.mjs';

test('출력 경로: 영상 파일은 출력 폴더 바로 아래, 작업 폴더·AD wav 폴더는 영상 이름 아래', () => {
  assert.deepEqual(buildOutputPathMap({ outDir: '/out/run', outStem: 'deck' }), {
    workDir: path.join('/out/run', 'deck'),
    adDir: path.join('/out/run', 'deck', 'ad'),
    mp3Path: path.join('/out/run', 'deck_SEEON_AD.mp3'),
    jsonPath: path.join('/out/run', 'deck_SEEON_AD.json'),
    logPath: path.join('/out/run', 'deck.log'),
  });
});
