import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleepReal } from 'node:timers/promises';
import { openSampleFrameReader, narrowToPointingRegion } from '../src/media/frame-source.mjs';
import { captureJpeg, toMjpegQscale, resolveCaptureSize, buildJpegCaptureArgList } from '../src/media/jpeg-capture.mjs';
import { resolveFfmpegPaths, runBinary } from '../src/media/ffmpeg.mjs';
import { SlideHistogramGate, PointingLocator, fitWithinLongEdge, MAX_FRAME_LONG_EDGE_PX } from '../src/product/core-modules.mjs';
import { POINTING_LOCATOR_OPTION_MAP } from '../src/session/renderer-constants.mjs';
import { createTestClip, readJpegSize } from './helpers/media-fixtures.mjs';

const { ffmpegPath } = resolveFfmpegPaths({ env: process.env });
const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-frame-'));
// 빨강 0~2s(1.0~1.5s 에 흰 상자), 파랑 2~4s. 상자는 400ms 격자 중 1.2s 에만 보인다. 1.6s 격자에도 보이면 게이트가
// 상자가 멈춘 1.6s 를 전환으로 잡고, 2.4s 에 확정될 파랑 전환은 쿨다운(1200ms) 안이라 놓친다(제품도 같다).
const deckPath = await createTestClip({
  dirPath, fileName: 'deck.mp4', colorTimeline: [['red', 2], ['blue', 2]], hasAudio: false,
  box: { x: 40, y: 40, w: 40, h: 40, fromSec: 1.0, toSec: 1.5 },
});
const readerList = [];
// 리더(ffmpeg)를 먼저 닫고 그 리더가 읽던 임시 폴더를 지운다.
after(() => {
  readerList.forEach((reader) => reader.close());
  fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 3 });
});
function openReader(filePath = deckPath) {
  const reader = openSampleFrameReader({ filePath, ffmpegPath });
  readerList.push(reader);
  return reader;
}

// createTestClip 이 만들지 못하는 영상(늦게 시작하는 영상 stream, 낮은 프레임률, 홀수 해상도)을 직접 만든다.
async function createRawClip({ fileName, inputArgList, filterComplex, outputArgList }) {
  const filePath = path.join(dirPath, fileName);
  await runBinary({
    binaryPath: ffmpegPath,
    argList: ['-v', 'error', '-y', ...inputArgList, '-filter_complex', filterComplex, ...outputArgList, filePath],
  });
  return filePath;
}

const isRed = ({ data, offset = 0 }) => data[offset] > 200 && data[offset + 2] < 80;
const isBlue = ({ data, offset = 0 }) => data[offset + 2] > 200 && data[offset] < 80;

// JPEG 를 ffmpeg 로 1×1 로 줄여 평균색을 읽는다.
async function readJpegColor(buffer) {
  const rgb = await runBinary({
    binaryPath: ffmpegPath, inputBuffer: buffer,
    argList: ['-v', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-vf', 'scale=1:1,format=rgb24', '-f', 'rawvideo', 'pipe:1'],
  });
  return Array.from(rgb);
}

test('400ms 격자 k 번째 프레임 = 영상 k×400ms 화면이고, 끝 뒤에는 null', async () => {
  const reader = openReader();
  const red = await reader.readFrameAt(400);
  assert.equal(red.width, 480);
  assert.equal(red.data.length, 480 * 270 * 4);
  assert.ok(red.data[0] > 200 && red.data[2] < 80, '빨강');
  const blue = await reader.readFrameAt(2400);
  assert.ok(blue.data[2] > 200 && blue.data[0] < 80, '파랑');
  await assert.rejects(reader.readFrameAt(800), /줄어들/);
  assert.equal(await reader.readFrameAt(60000), null);
});

test('제품 SlideHistogramGate 가 첫 프레임과 2초 전환을 잡는다', async () => {
  const reader = openReader();
  const gate = new SlideHistogramGate({});
  const verdictList = [];
  for (let timeMs = 400; timeMs <= 3600; timeMs += 400) {
    const imageData = await reader.readFrameAt(timeMs);
    const verdict = gate.sample({ imageData, ts: 10_000 + timeMs });
    if (verdict.isFirst || verdict.isTransition) verdictList.push([timeMs, verdict.isFirst ? 'first' : 'transition']);
  }
  assert.equal(verdictList[0][1], 'first');
  const transition = verdictList.find(([, kind]) => kind === 'transition');
  assert.ok(transition && transition[0] >= 2000 && transition[0] <= 2800, JSON.stringify(verdictList));
});

test('제품 PointingLocator 가 흰 상자 자리를 찾는다(포인팅은 재현된다)', async () => {
  const reader = openReader();
  const locator = new PointingLocator(POINTING_LOCATOR_OPTION_MAP);
  for (const timeMs of [400, 800, 1200]) locator.sample({ imageData: await reader.readFrameAt(timeMs), ts: timeMs });
  const motion = locator.locate({ nowTs: 1200 });
  assert.equal(motion.hasRegion, true);
  assert.ok(motion.rect.x <= 0.13 && motion.rect.x + motion.rect.w >= 0.24 && motion.rect.w < 0.3, JSON.stringify(motion.rect));
});

test('포인팅 crop 식은 main.js:625-631 과 같다(여백 0.12, 0~1 로 자름)', () => {
  assert.deepEqual(narrowToPointingRegion({ sub: { x: 0.05, y: 0.5, w: 0.2, h: 0.6 } }),
    { x: 0, y: 0.38, w: 0.37, h: 0.62 });
});

test('JPEG 캡처: 전체 프레임·crop 크기, 영상 끝 뒤 시각은 마지막 프레임', async () => {
  assert.equal(toMjpegQscale(0.92), 2);
  const full = await captureJpeg({ filePath: deckPath, timeMs: 1200, durationMs: 4000, ffmpegPath });
  assert.deepEqual(readJpegSize(full), { width: 320, height: 180 });
  const cropped = await captureJpeg({ filePath: deckPath, timeMs: 1200, durationMs: 4000, normRect: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, ffmpegPath });
  assert.deepEqual(readJpegSize(cropped), { width: 160, height: 90 });
  // 긴 변 1280 안의 영역은 제품 canvas 크기가 Math.max(2, Math.round(영역 화소))다(frame-scale.js fitWithinLongEdge). 4:2:0 영상이어도 홀수 크기를 그대로 낸다.
  const oddCropped = await captureJpeg({ filePath: deckPath, timeMs: 1200, durationMs: 4000, normRect: { x: 0.11, y: 0.11, w: 0.36, h: 0.35 }, ffmpegPath });
  assert.deepEqual(readJpegSize(oddCropped), { width: Math.round(320 * 0.36), height: Math.round(180 * 0.35) });
  const late = await captureJpeg({ filePath: deckPath, timeMs: 99_000, durationMs: 4000, ffmpegPath });
  assert.ok(late && late.length > 100);
  const [r, , b] = await readJpegColor(late);
  assert.ok(b > 200 && r < 80, `끝 뒤 JPEG 는 마지막 프레임(파랑): ${r},${b}`);
});

test('4:3 영상도 480×270 으로 늘려 샘플링한다(제품 drawImage 와 같다)', async () => {
  // 오른쪽 절반이 흰 4:3 화면. 늘려 그리면 출력 오른쪽 끝도 희고, 비율을 지켜 여백을 두면 검다.
  const filePath = await createTestClip({
    dirPath, fileName: 'square.mp4', width: 240, height: 180, colorTimeline: [['green', 1]], hasAudio: false,
    box: { x: 120, y: 0, w: 120, h: 180, fromSec: 0, toSec: 1 },
  });
  const frame = await openReader(filePath).readFrameAt(400);
  assert.equal(frame.data.length, 480 * 270 * 4);
  const rightEdge = (135 * 480 + 475) * 4;
  const leftEdge = (135 * 480 + 4) * 4;
  assert.ok(frame.data[rightEdge] > 200 && frame.data[rightEdge + 1] > 200 && frame.data[rightEdge + 2] > 200, '오른쪽 끝 흰색');
  assert.ok(frame.data[leftEdge + 1] > 80 && frame.data[leftEdge] < 60, '왼쪽 끝 초록');
});

test('역압: 읽지 않으면 버퍼가 프레임 두 장분을 넘지 않는다(긴 영상 메모리 상한)', async () => {
  const filePath = await createTestClip({ dirPath, fileName: 'long.mp4', colorTimeline: [['gray', 20]], hasAudio: false });
  const reader = openReader(filePath);
  await reader.readFrameAt(400);
  await sleepReal(400);
  assert.ok(reader.getBufferedByteLength() < 480 * 270 * 4 * 2, `${reader.getBufferedByteLength()} bytes`);
});

test('격자 시각의 프레임은 그 시각에 화면에 보이는 프레임이다(다음 프레임을 당겨 오지 않는다)', async () => {
  // 1.72s 에 파랑으로 바뀐다. 1.6s 에 보이는 프레임은 1.6s 프레임(빨강)이고, 1.76s 프레임(파랑)이 아니다.
  const filePath = await createTestClip({ dirPath, fileName: 'edge.mp4', colorTimeline: [['red', 1.72], ['blue', 2]], hasAudio: false });
  const reader = openReader(filePath);
  assert.ok(isRed(await reader.readFrameAt(1600)), '1.6s 빨강');
  assert.ok(isBlue(await reader.readFrameAt(2000)), '2.0s 파랑');
  assert.ok(isBlue(await reader.readFrameAt(3600)), '3.6s 파랑(영상 안의 마지막 격자)');
  assert.equal(await reader.readFrameAt(4000), null);
  const [r, , b] = await readJpegColor(await captureJpeg({ filePath, timeMs: 1700, durationMs: 3720, ffmpegPath }));
  assert.ok(r > 200 && b < 80, `1.7s JPEG 빨강: ${r},${b}`);
});

test('영상 stream 이 늦게 시작해도 격자·캡처 시각은 컨테이너 시작부터 잰 영상 시각이다', async () => {
  // 오디오는 0s, 영상은 1s 에 시작한다. 영상 안에서 빨강 1s, 파랑 2s → 영상 시각 빨강 1~2s, 파랑 2~4s.
  const filePath = await createRawClip({
    fileName: 'late-video.mp4',
    inputArgList: [
      '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=25:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=25:d=2',
      '-f', 'lavfi', '-i', 'aevalsrc=0:c=stereo:s=48000:d=4',
    ],
    filterComplex: '[0:v][1:v]concat=n=2:v=1:a=0,setpts=PTS+1/TB,format=yuv420p[v];[2:a]anull[a]',
    outputArgList: ['-map', '[v]', '-map', '[a]', '-c:a', 'aac', '-c:v', 'libx264', '-preset', 'veryfast'],
  });
  const reader = openReader(filePath);
  assert.ok(isRed(await reader.readFrameAt(400)), '영상 시작 전은 첫 프레임');
  assert.ok(isRed(await reader.readFrameAt(1600)), '1.6s 빨강');
  assert.ok(isBlue(await reader.readFrameAt(2000)), '2.0s 파랑');
  assert.ok(isBlue(await reader.readFrameAt(3600)), '3.6s 파랑');
  const [r1, , b1] = await readJpegColor(await captureJpeg({ filePath, timeMs: 1600, durationMs: 4000, ffmpegPath }));
  assert.ok(r1 > 200 && b1 < 80, `1.6s JPEG 빨강: ${r1},${b1}`);
  const [r2, , b2] = await readJpegColor(await captureJpeg({ filePath, timeMs: 2400, durationMs: 4000, ffmpegPath }));
  assert.ok(b2 > 200 && r2 < 80, `2.4s JPEG 파랑: ${r2},${b2}`);
});

test('프레임이 드문 영상(1fps)도 그 시각에 보이는 프레임을 샘플·캡처하고 끝 근처도 비지 않는다', async () => {
  const filePath = await createRawClip({
    fileName: 'low-fps.mp4',
    inputArgList: ['-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=1:d=2', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=1:d=2'],
    filterComplex: '[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]',
    outputArgList: ['-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '100'],
  });
  const reader = openReader(filePath);
  assert.ok(isRed(await reader.readFrameAt(1600)), '1.6s 빨강(1s 프레임이 보이는 중)');
  assert.ok(isBlue(await reader.readFrameAt(2000)), '2.0s 파랑');
  assert.ok(isBlue(await reader.readFrameAt(3600)), '3.6s 파랑(3s 프레임이 보이는 중)');
  const [r1, , b1] = await readJpegColor(await captureJpeg({ filePath, timeMs: 1500, durationMs: 4000, ffmpegPath }));
  assert.ok(r1 > 200 && b1 < 80, `1.5s JPEG 빨강: ${r1},${b1}`);
  const tail = await captureJpeg({ filePath, timeMs: 3500, durationMs: 4000, ffmpegPath });
  assert.ok(tail, '마지막 프레임 구간(3~4s) 캡처');
  const [r2, , b2] = await readJpegColor(tail);
  assert.ok(b2 > 200 && r2 < 80, `3.5s JPEG 파랑: ${r2},${b2}`);
});

test('JPEG 크기: 영역 화소의 긴 변이 1280 을 넘으면 제품 fitWithinLongEdge 크기로 줄이고, 그 안이면 줄이지 않는다', () => {
  assert.equal(MAX_FRAME_LONG_EDGE_PX, 1280);
  const caseList = [
    [{ frameWidth: 1920, frameHeight: 1080 }, { width: 1920, height: 1080 }, { width: 1280, height: 720 }],
    [{ frameWidth: 1080, frameHeight: 1920 }, { width: 1080, height: 1920 }, { width: 720, height: 1280 }],
    [{ frameWidth: 1920, frameHeight: 1080, normRect: { x: 0, y: 0, w: 0.5, h: 0.5 } }, { width: 960, height: 540 }, { width: 960, height: 540 }],
    [{ frameWidth: 1920, frameHeight: 1080, normRect: { x: 0.05, y: 0.1, w: 0.9, h: 0.6 } }, { width: 1728, height: 648 }, { width: 1280, height: 480 }],
    [{ frameWidth: 321, frameHeight: 181, normRect: { x: 0, y: 0.38, w: 0.37, h: 0.62 } }, { width: 119, height: 112 }, { width: 119, height: 112 }],
  ];
  for (const [input, crop, output] of caseList) {
    const size = resolveCaptureSize(input);
    assert.deepEqual(size, { crop, output }, JSON.stringify(input));
    const regionWidth = input.frameWidth * (input.normRect?.w ?? 1);
    const regionHeight = input.frameHeight * (input.normRect?.h ?? 1);
    assert.deepEqual(size.output, fitWithinLongEdge({ width: regionWidth, height: regionHeight }), '제품 함수로 정한 크기');
  }
  const argText = (option) => buildJpegCaptureArgList({ filePath: 'v.mp4', timeMs: 0, qscale: 2, ...option }).join(' ');
  assert.match(argText({ frameWidth: 1920, frameHeight: 1080 }), /round=up,scale=w=1280:h=720:flags=bilinear /);
  assert.doesNotMatch(argText({ frameWidth: 1280, frameHeight: 720 }), /scale=/, '상한 안이면 예전과 같은 인자');
  assert.doesNotMatch(argText({}), /scale=/, '원본 크기를 모르면 줄이지 않는다');
});

test('JPEG 캡처: 원본 크기를 주면 긴 변 1280 상한으로 줄여 굽는다(crop 뒤 줄임)', async () => {
  const filePath = await createTestClip({ dirPath, fileName: 'wide.mp4', width: 1600, height: 900, colorTimeline: [['red', 1]], hasAudio: false });
  const sizeOption = { frameWidth: 1600, frameHeight: 900 };
  const full = await captureJpeg({ filePath, timeMs: 400, durationMs: 1000, ffmpegPath, ...sizeOption });
  assert.deepEqual(readJpegSize(full), { width: 1280, height: 720 });
  const [r, , b] = await readJpegColor(full);
  assert.ok(r > 200 && b < 80, `줄인 JPEG 도 빨강: ${r},${b}`);
  const half = await captureJpeg({ filePath, timeMs: 400, durationMs: 1000, ffmpegPath, ...sizeOption, normRect: { x: 0, y: 0, w: 0.5, h: 0.5 } });
  assert.deepEqual(readJpegSize(half), { width: 800, height: 450 }, '상한 안의 crop 은 줄이지 않는다');
  const wide = await captureJpeg({ filePath, timeMs: 400, durationMs: 1000, ffmpegPath, ...sizeOption, normRect: { x: 0.05, y: 0.1, w: 0.9, h: 0.6 } });
  assert.deepEqual(readJpegSize(wide), resolveCaptureSize({ ...sizeOption, normRect: { w: 0.9, h: 0.6 } }).output);
  assert.deepEqual(readJpegSize(wide), { width: 1280, height: 480 });
  const unknownSize = await captureJpeg({ filePath, timeMs: 400, durationMs: 1000, ffmpegPath });
  assert.deepEqual(readJpegSize(unknownSize), { width: 1600, height: 900 });
});

test('홀수 해상도도 480×270 으로 샘플링하고 JPEG 는 원본 화소 기준으로 자른다', async () => {
  const filePath = await createRawClip({
    fileName: 'odd.mp4',
    inputArgList: ['-f', 'lavfi', '-i', 'color=c=green:s=321x181:r=25:d=1'],
    filterComplex: '[0:v]format=yuv444p[v]',
    outputArgList: ['-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast'],
  });
  const frame = await openReader(filePath).readFrameAt(400);
  assert.equal(frame.width, 480);
  assert.equal(frame.height, 270);
  assert.equal(frame.data.length, 480 * 270 * 4);
  const full = await captureJpeg({ filePath, timeMs: 400, durationMs: 1000, ffmpegPath });
  assert.deepEqual(readJpegSize(full), { width: 321, height: 181 });
  const cropped = await captureJpeg({
    filePath, timeMs: 400, durationMs: 1000, ffmpegPath, normRect: narrowToPointingRegion({ sub: { x: 0.05, y: 0.5, w: 0.2, h: 0.6 } }),
  });
  // 제품 값: round(321×0.37)=119, round(181×0.62)=112
  assert.deepEqual(readJpegSize(cropped), { width: 119, height: 112 });
});

test('격자 밖 시각은 그 시각 이하의 마지막 격자 칸을 준다(미래 칸을 당겨 오지 않는다)', async () => {
  // 0.6s 에 파랑으로 바뀐다. 650ms 는 400ms 칸(빨강)이고 800ms 칸(파랑)이 아니다.
  const filePath = await createTestClip({ dirPath, fileName: 'off-grid.mp4', colorTimeline: [['red', 0.6], ['blue', 1]], hasAudio: false });
  const reader = openReader(filePath);
  assert.ok(isRed(await reader.readFrameAt(650)), '650ms → 400ms 칸 빨강');
  assert.ok(isBlue(await reader.readFrameAt(800)), '800ms 칸 파랑');
  assert.ok(isBlue(await reader.readFrameAt(1199.9999999)), '나눗셈 오차로 1200ms 칸이 한 칸 아래로 떨어지지 않는다');
});

test('RGBA 색이 원래 색과 1 단계 안이다(swscale 정확 반올림·전체 크로마 보간)', async () => {
  const filePath = await createTestClip({ dirPath, fileName: 'tone.mp4', colorTimeline: [['0xC86432', 1]], hasAudio: false });
  const { data } = await openReader(filePath).readFrameAt(400);
  const offset = (135 * 480 + 240) * 4;
  const rgb = [data[offset], data[offset + 1], data[offset + 2]];
  [200, 100, 50].forEach((expected, index) => assert.ok(Math.abs(rgb[index] - expected) <= 1, `${rgb} ≈ 200,100,50`));
});

test('ffmpeg 가 실패하면 null 대신 오류를 내고, 겹친 읽기는 거부한다', async () => {
  await assert.rejects(openReader(path.join(dirPath, 'missing.mp4')).readFrameAt(400), /ffmpeg/);
  const reader = openReader();
  const pending = reader.readFrameAt(400);
  await assert.rejects(reader.readFrameAt(800), /동시/);
  assert.ok(isRed(await pending));
});
