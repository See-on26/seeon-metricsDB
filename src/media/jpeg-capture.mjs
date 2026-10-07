import { runBinary } from './ffmpeg.mjs';
import { CROP_JPEG_QUALITY } from '../product/core-modules.mjs';

// 영상 끝을 넘는 시각은 마지막 프레임으로 당긴다(끝난 뒤 판정도 마지막 화면을 본다). probe 길이는 ms 로 반올림했고
// 영상 stream 이 오디오보다 조금 일찍 끝날 수 있어 끝에서 조금 앞을 본다.
const LAST_FRAME_MARGIN_MS = 80;

// canvas toBlob 품질(0~1)을 ffmpeg mjpeg qscale(2 최고 ~ 31)로 옮긴다. 0.9 이상은 최고 품질로 본다.
export function toMjpegQscale(quality) {
  if (quality >= 0.9) return 2;
  return Math.min(31, Math.max(2, Math.round(2 + (0.9 - quality) * 40)));
}

// 제품은 그 순간 <video> 에 보이는 프레임을 canvas 에 그려 JPEG 로 굽는다(main.js:620-635). 입력 -ss 정확 탐색은 그 시각
// 이후 첫 프레임을 내서, 프레임이 드문 영상에서는 다음 슬라이드를 잡고 마지막 프레임 구간에서는 아무것도 내지 않는다.
// 그래서 탐색은 그 시각 이전 키프레임까지만 하고(-noaccurate_seek), 탐색 시각이 출력 시각 0 이 되므로 fps 필터
// start_time=0·round=up 으로 0 이하에서 시작한 마지막 프레임을 고른다. 샘플 격자(frame-source)와 같은 "그 시각에 보이는
// 프레임" 규칙이다. crop 크기는 원본 화소 기준 제품 canvas 크기 Math.max(2, Math.round(영역 화소))와 같다(main.js:629-630).
// crop 필터는 4:2:0 입력에서 크기·위치를 짝수로 내려 깎으므로 exact=1 로 그대로 자르게 한다(mjpeg 는 홀수 크기를 인코딩한다).
// 위치는 제품의 소수 좌표를 가장 가까운 화소로 반올림하고, 프레임 밖으로 나가면 crop 필터가 안쪽으로 당긴다.
export function buildJpegCaptureArgList({ filePath, timeMs, normRect = null, qscale }) {
  const filterList = ['fps=fps=1:start_time=0:round=up'];
  if (normRect) {
    filterList.push(`crop=w=max(2\\,round(iw*${normRect.w})):h=max(2\\,round(ih*${normRect.h})):x=round(iw*${normRect.x}):y=round(ih*${normRect.y}):exact=1`);
  }
  return [
    '-v', 'error', '-noaccurate_seek', '-ss', (timeMs / 1000).toFixed(3), '-i', filePath, '-map', '0:V:0', '-frames:v', '1',
    '-vf', filterList.join(','), '-pix_fmt', 'yuvj420p', '-q:v', String(qscale), '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1',
  ];
}

export async function captureJpeg({ filePath, timeMs, durationMs, normRect = null, ffmpegPath, quality = CROP_JPEG_QUALITY, signal = null }) {
  if (!(durationMs > 0)) throw new Error(`JPEG 캡처에 영상 길이가 없다: ${durationMs}`);
  const clampedMs = Math.max(0, Math.min(timeMs, durationMs - LAST_FRAME_MARGIN_MS));
  const buffer = await runBinary({
    binaryPath: ffmpegPath, argList: buildJpegCaptureArgList({ filePath, timeMs: clampedMs, normRect, qscale: toMjpegQscale(quality) }), signal,
  });
  return buffer.length ? buffer : null;
}
