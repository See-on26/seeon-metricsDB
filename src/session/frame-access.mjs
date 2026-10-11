import { captureJpeg } from '../media/jpeg-capture.mjs';
import { POINTING_SAMPLE_MS } from './renderer-constants.mjs';

// 프레임 읽기·JPEG 캡처 한 번이 실제 시간으로 이보다 오래 걸리면 ffmpeg 가 멈춘 것으로 본다. 읽기·캡처 동안은 hold 로
// 가상 시계가 서 있어서, 상한이 없으면 멈춘 ffmpeg 하나가 영상 처리를 끝없이 붙잡는다. 긴 GOP 고해상도 영상의 탐색 디코드도 덮는 값이다.
export const FRAME_IO_TIMEOUT_MS = 60000;

class FrameIoTimeoutError extends Error {}

const formatSec = (ms) => `${Number((ms / 1000).toFixed(3))}초`;

// 실제 타이머로 상한을 둔다. 넘으면 onTimeout 으로 그 작업을 끊고 오류로 거부한다. 먼저 끝나면 실제 타이머를 거둔다.
function raceRealTimeout({ promise, timeoutMs, buildError, onTimeout }) {
  let handle = null;
  const timeoutPromise = new Promise((resolve, reject) => {
    handle = setTimeout(() => {
      const error = buildError();
      onTimeout(error);
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(handle));
}

// 세션이 보는 화면 입력. 제품은 그 순간 <video> 에 보이는 프레임을 그리는데, 영상이 끝난 뒤나 영상 stream 이 오디오보다
// 먼저 끝난 뒤에도 마지막 화면이 계속 보인다. 그래서 그 시각들에도 null 대신 마지막 화면을 준다.
// 멈춘 ffmpeg 는 onFatal 로 알리고, 그 영상은 실패로 끝낸다(멈춘 읽기는 리더를 닫고, 멈춘 캡처는 그 프로세스만 죽인다).
// frameWidth·frameHeight 는 ffmpeg 필터가 받는 화소(자동 회전 뒤), displayWidth·displayHeight 는 제품 <video> 표시 크기다
// (probe resolveFrameGeometry). JPEG 를 제품 canvas 크기(긴 변 1280 상한)로 맞추는 데 쓴다(jpeg-capture resolveCaptureSize).
export function createFrameAccess({
  clock, frameReader, filePath, mediaDurationMs, frameWidth = null, frameHeight = null, displayWidth = frameWidth, displayHeight = frameHeight,
  ffmpegPath, timeoutMs = FRAME_IO_TIMEOUT_MS, sampleMs = POINTING_SAMPLE_MS, onFatal = () => {}, log = console,
}) {
  // 격자 마지막 칸은 영상 길이보다 작은 마지막 sampleMs 배수다. ffmpeg fps 필터는 영상 끝 시각의 칸을 내지 않는다.
  const lastGridMs = Math.max(0, Math.floor((mediaDurationMs - 1) / sampleMs) * sampleMs);
  const stats = { captureCount: 0, captureFailCount: 0, captureFallbackCount: 0 };
  let lastFrame = null;
  let lastFrameTimeMs = null;

  // 영상 끝 뒤 시각은 마지막 격자 칸으로 당긴다. 영상 stream 이 먼저 끝나 리더가 null 을 주면 마지막으로 받은 프레임을 준다.
  async function readFrameAt(timeMs) {
    const clampedMs = Math.min(timeMs, lastGridMs);
    const frame = await clock.hold(() => raceRealTimeout({
      promise: frameReader.readFrameAt(clampedMs),
      timeoutMs,
      buildError: () => new FrameIoTimeoutError(
        `프레임 읽기가 실제 ${formatSec(timeoutMs)} 안에 끝나지 않았다(영상 ${clampedMs}ms) — ffmpeg 가 멈춘 것으로 보고 영상을 실패로 끝낸다`,
      ),
      onTimeout: (error) => {
        frameReader.close();
        onFatal(error);
      },
    }));
    if (!frame) return lastFrame;
    lastFrame = frame;
    lastFrameTimeMs = clampedMs;
    return frame;
  }

  function runCapture({ timeMs, normRect }) {
    const controller = new AbortController();
    return raceRealTimeout({
      promise: captureJpeg({
        filePath, timeMs, durationMs: mediaDurationMs, normRect, frameWidth, frameHeight, displayWidth, displayHeight, ffmpegPath, signal: controller.signal,
      }),
      timeoutMs,
      buildError: () => new FrameIoTimeoutError(
        `JPEG 캡처가 실제 ${formatSec(timeoutMs)} 안에 끝나지 않았다(영상 ${Math.round(timeMs)}ms) — ffmpeg 가 멈춘 것으로 보고 영상을 실패로 끝낸다`,
      ),
      onTimeout: () => controller.abort(),
    });
  }

  // canvas 캡처는 즉시라 hold 로 가상 시간을 멈추고 뜬다. 영상 stream 이 끝난 뒤라 빈 결과가 오면 마지막으로 받은 격자 칸 시각으로 다시 뜬다.
  async function captureFrameJpeg({ timeMs, normRect = null }) {
    stats.captureCount += 1;
    try {
      const buffer = await clock.hold(async () => {
        const first = await runCapture({ timeMs, normRect });
        if (first || lastFrameTimeMs === null || lastFrameTimeMs >= timeMs) return first;
        stats.captureFallbackCount += 1;
        return runCapture({ timeMs: lastFrameTimeMs, normRect });
      });
      if (!buffer) {
        stats.captureFailCount += 1;
        log.warn(`[factory] 프레임 캡처가 비었다(${Math.round(timeMs)}ms)`);
      }
      return buffer;
    } catch (error) {
      if (error instanceof FrameIoTimeoutError) {
        onFatal(error);
        return null;
      }
      stats.captureFailCount += 1;
      log.warn(`[factory] 프레임 캡처 실패(${Math.round(timeMs)}ms): ${error.message}`);
      return null;
    }
  }

  return { readFrameAt, captureFrameJpeg, getStats: () => ({ ...stats }) };
}
