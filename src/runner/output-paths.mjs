// src/runner/output-paths.mjs
import path from 'node:path';

export function buildOutputPathMap({ outDir, outStem }) {
  const workDir = path.join(outDir, outStem);
  return {
    workDir,
    adDir: path.join(workDir, 'ad'),
    mp3Path: path.join(outDir, `${outStem}_SEEON_AD.mp3`),
    jsonPath: path.join(outDir, `${outStem}_SEEON_AD.json`),
    logPath: path.join(outDir, `${outStem}.log`),
  };
}
