import fs from 'node:fs';
import path from 'node:path';
import { verifyOutput } from '../src/output/verify-output.mjs';
import { resolveFfmpegPaths } from '../src/media/ffmpeg.mjs';

// 공장 출력 하나를 검사한다: mp3 길이 공식과 AD 자리. 통과하면 종료 코드 0, 어긋나면 1, 사용법이 틀리면 2.
const jsonPath = process.argv[2];
if (!jsonPath) {
  console.error('사용법: node tools/verify-output.mjs <out/.../<영상>_SEEON_AD.json>');
  process.exit(2);
}
const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const { ffmpegPath, ffprobePath } = resolveFfmpegPaths({ env: process.env });
const result = await verifyOutput({ outDir: path.dirname(path.resolve(jsonPath)), report, ffmpegPath, ffprobePath });
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.isOk ? 0 : 1;
