import fs from 'node:fs';
import path from 'node:path';
import { verifyOutput } from '../src/output/verify-output.mjs';
import { resolveFfmpegPaths } from '../src/media/ffmpeg.mjs';

// 공장 출력 하나를 검사한다: 영상 길이 기준 mp3 길이 공식, 원음 범위(영상 0~끝을 빈틈·겹침 없이), AD 자리.
// 통과하면 종료 코드 0, 검사에서 어긋나면 1. 검사를 하지 못한 실행 오류(사용법, JSON 을 읽지 못함, mp3 없음, ffmpeg·ffprobe 실패)는
// 일괄 스크립트가 "검사 불통과" 와 가를 수 있게 2 로 끝내고 결과 JSON 은 찍지 않는다.
const EXIT_CODE_MAP = { ok: 0, mismatch: 1, error: 2 };

const jsonPath = process.argv[2];
if (!jsonPath) {
  console.error('사용법: node tools/verify-output.mjs <out/.../<영상>_SEEON_AD.json>');
  process.exit(EXIT_CODE_MAP.error);
}
try {
  const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const { ffmpegPath, ffprobePath } = resolveFfmpegPaths({ env: process.env });
  const result = await verifyOutput({ outDir: path.dirname(path.resolve(jsonPath)), report, ffmpegPath, ffprobePath });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.isOk ? EXIT_CODE_MAP.ok : EXIT_CODE_MAP.mismatch;
} catch (error) {
  console.error(`검사를 실행하지 못했다: ${error.message}`);
  process.exitCode = EXIT_CODE_MAP.error;
}
