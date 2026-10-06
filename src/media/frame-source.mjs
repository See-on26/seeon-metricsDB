import { spawnTracked } from './ffmpeg.mjs';
import {
  POINTING_SAMPLE_MS, POINTING_SAMPLE_WIDTH, POINTING_SAMPLE_HEIGHT, POINTING_CROP_MARGIN,
} from '../session/renderer-constants.mjs';

const STDERR_TAIL_LENGTH = 2000;

// 제품은 400ms 마다 공유 화면 ROI 를 480×270 canvas 에 늘려 그려 RGBA 를 읽는다(main.js:625-643). 비율을 지키지 않으므로
// 4:3·홀수 해상도도 여백 없이 480×270 으로 늘린다. 공장은 ROI 가 전체 프레임이고, ffmpeg 가 같은 격자로 줄인 원시 프레임을 흘린다.
// 격자 k 번째 프레임은 영상 시각 k×sampleMs 에 화면에 보이는 프레임, 곧 그 시각 이하에서 시작한 마지막 프레임이다.
// fps 필터 round=up 이 그 프레임을 고른다(기본 near 는 반 칸 안의 다음 프레임을 당겨 온다). start_time=0 은 영상 stream 이
// 늦게 시작해도 격자를 컨테이너 시작(영상 시각 0)에 붙이고 그 앞을 첫 프레임으로 채운다. fps_mode passthrough 는 출력 쪽에서
// 프레임을 더 복제하거나 버리지 않게 해 fps 필터가 낸 격자를 그대로 둔다. 0:V 는 표지 그림이 아닌 첫 영상 stream 이다.
// swscale 기본 반올림·크로마 처리는 YUV→RGB 값을 2~3 단계 낮게 내서, accurate_rnd·full_chroma_int 로 원래 색에 맞춘다.
const SAMPLE_SCALE_FLAGS = 'bilinear+accurate_rnd+full_chroma_int';

export function buildSampleFrameArgList({ filePath, sampleMs, width, height }) {
  return [
    '-v', 'error', '-i', filePath, '-map', '0:V:0',
    '-vf', `fps=fps=1000/${sampleMs}:start_time=0:round=up,scale=${width}:${height}:flags=${SAMPLE_SCALE_FLAGS},format=rgba`,
    '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1',
  ];
}

// 비동기 반복자는 next() 를 부를 때만 읽는다. 읽지 않는 동안 stdout 내부 버퍼가 highWaterMark 에서 멈추고 파이프가 차서
// ffmpeg 쓰기가 막히므로, 긴 영상도 들고 있는 바이트가 프레임 한 장 남짓을 넘지 않는다.
export function openSampleFrameReader({
  filePath, ffmpegPath, sampleMs = POINTING_SAMPLE_MS, width = POINTING_SAMPLE_WIDTH, height = POINTING_SAMPLE_HEIGHT,
}) {
  const frameByteLength = width * height * 4;
  const child = spawnTracked(ffmpegPath, buildSampleFrameArgList({ filePath, sampleMs, width, height }), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // 실행 파일을 띄우지 못하면 ChildProcess 가 'error' 를 내는데, 듣는 곳이 없으면 프로세스가 죽는다. 받아 두었다가 읽기에서 거부한다.
  let spawnError = null;
  child.once('error', (error) => { spawnError = error; });
  const exitCodePromise = new Promise((resolve) => child.once('close', resolve));
  let stderrTail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text) => { stderrTail = (stderrTail + text).slice(-STDERR_TAIL_LENGTH); });

  const chunkIterator = child.stdout[Symbol.asyncIterator]();
  const chunkList = [];
  let chunkByteLength = 0;
  let lastFrame = null;
  let lastFrameIndex = -1;
  let lastRequestedIndex = -1;
  let streamError = null;
  let isEnded = false;
  let isClosed = false;
  let isReading = false;

  // 프레임 한 장 바이트가 모이면 true, stream 이 끝나면 false 다.
  async function fillFrameBytes() {
    while (chunkByteLength < frameByteLength) {
      const { value, done } = await chunkIterator.next();
      if (done) return false;
      chunkList.push(value);
      chunkByteLength += value.length;
    }
    return true;
  }

  // 앞쪽 프레임 한 장 바이트를 떼어 낸다. 요청 시각까지 건너뛰는 프레임은 복사하지 않는다.
  function shiftFrameBytes({ isKept }) {
    const data = isKept ? new Uint8ClampedArray(frameByteLength) : null;
    let offset = 0;
    while (offset < frameByteLength) {
      const head = chunkList[0];
      const takeLength = Math.min(head.length, frameByteLength - offset);
      if (data) data.set(head.subarray(0, takeLength), offset);
      if (takeLength === head.length) chunkList.shift();
      else chunkList[0] = head.subarray(takeLength);
      offset += takeLength;
    }
    chunkByteLength -= frameByteLength;
    return data;
  }

  // 영상 끝과 ffmpeg 실패를 가른다. 실패를 null(영상 끝)로 삼키면 빈 판정이 조용히 쌓인다.
  async function finishStream() {
    isEnded = true;
    const exitCode = await exitCodePromise;
    if (spawnError) streamError = new Error(`ffmpeg 를 띄우지 못했다: ${spawnError.message}`);
    else if (exitCode !== 0 && !isClosed) streamError = new Error(`ffmpeg 프레임 디코드 실패(종료 코드 ${exitCode}): ${stderrTail}`);
    if (streamError) throw streamError;
  }

  async function readFrameAt(timeMs) {
    if (streamError) throw streamError;
    if (isClosed) throw new Error('닫힌 프레임 리더에서 읽었다');
    if (isReading) throw new Error('프레임 리더는 동시에 읽을 수 없다(앞 요청을 기다린 뒤 읽는다)');
    // 격자 밖 시각은 그 시각 이하의 마지막 칸이다(그 시각에 보이는 프레임 규칙). 1e-6 은 나눗셈 오차로 격자 시각이 한 칸 아래로 떨어지지 않게 한다.
    const targetIndex = Math.floor(timeMs / sampleMs + 1e-6);
    if (targetIndex < lastRequestedIndex) throw new Error(`프레임 요청 시각이 줄어들었다: ${timeMs}ms`);
    lastRequestedIndex = targetIndex;
    isReading = true;
    try {
      while (!isEnded && lastFrameIndex < targetIndex) {
        if (!(await fillFrameBytes())) {
          await finishStream();
          break;
        }
        lastFrameIndex += 1;
        const data = shiftFrameBytes({ isKept: lastFrameIndex === targetIndex });
        if (data) lastFrame = { data, width, height };
      }
    } finally {
      isReading = false;
    }
    return lastFrameIndex === targetIndex ? lastFrame : null;
  }

  return {
    readFrameAt,
    getBufferedByteLength: () => chunkByteLength + child.stdout.readableLength,
    close() {
      isClosed = true;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
  };
}

// main.js:580-586 의 narrowToPointingRegion 과 같은 식. ROI 가 전체 프레임이라 결과도 프레임 기준 정규화 사각형이다.
export function narrowToPointingRegion({ sub, margin = POINTING_CROP_MARGIN }) {
  const x0 = Math.max(0, sub.x - margin);
  const y0 = Math.max(0, sub.y - margin);
  const x1 = Math.min(1, sub.x + sub.w + margin);
  const y1 = Math.min(1, sub.y + sub.h + margin);
  const round = (value) => Math.round(value * 1e6) / 1e6;
  return { x: round(x0), y: round(y0), w: round(x1 - x0), h: round(y1 - y0) };
}
