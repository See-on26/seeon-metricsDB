import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVirtualClock } from '../src/clock/virtual-clock.mjs';
import { createFrameAccess } from '../src/session/frame-access.mjs';
import { openSampleFrameReader } from '../src/media/frame-source.mjs';
import { resolveFfmpegPaths, runBinary } from '../src/media/ffmpeg.mjs';
import { createTestClip } from './helpers/media-fixtures.mjs';
import { waitRealUntil } from './helpers/real-wait.mjs';

const { ffmpegPath } = resolveFfmpegPaths({ env: process.env });
const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-frame-access-'));
const silentLog = { log() {}, warn() {} };

const isBlue = ({ data }) => data[2] > 200 && data[0] < 80;

async function readJpegColor(buffer) {
  const rgb = await runBinary({
    binaryPath: ffmpegPath, inputBuffer: buffer,
    argList: ['-v', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-vf', 'scale=1:1,format=rgb24', '-f', 'rawvideo', 'pipe:1'],
  });
  return Array.from(rgb);
}

// 영상 stream 은 2초(빨강 1초 → 파랑 1초)에서 끝나고 오디오는 4초까지 간다. 제품 <video> 는 그 뒤로 마지막 화면을 보여 준다.
const shortVideoPath = path.join(dirPath, 'short-video.mp4');
await runBinary({
  binaryPath: ffmpegPath,
  argList: [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=25:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=25:d=1',
    '-f', 'lavfi', '-i', 'aevalsrc=0:c=stereo:s=48000:d=4', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]',
    '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', shortVideoPath,
  ],
});

// 자기 pid 를 적고 멈춰 있는 가짜 ffmpeg. macOS 는 새 실행 파일의 첫 실행을 수백 ms 검사하므로 한 번 미리 돌려 둔다.
async function createHangingBinary() {
  const pidPath = path.join(dirPath, `hang-${process.hrtime.bigint()}.pid`);
  const scriptPath = `${pidPath}.sh`;
  fs.writeFileSync(scriptPath, `#!/bin/sh\n[ "$1" = warmup ] && exit 0\necho $$ > '${pidPath}'\nexec sleep 30\n`, { mode: 0o755 });
  await runBinary({ binaryPath: scriptPath, argList: ['warmup'] });
  return { scriptPath, readPid: () => Number(fs.readFileSync(pidPath, 'utf8').trim()) };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('영상 stream 이 끝난 뒤 시각은 마지막으로 받은 프레임을 주고, JPEG 캡처는 마지막 프레임 시각으로 다시 떠 null 을 내지 않는다', async () => {
  const clock = createVirtualClock();
  const frameReader = openSampleFrameReader({ filePath: shortVideoPath, ffmpegPath });
  const access = createFrameAccess({ clock, frameReader, filePath: shortVideoPath, mediaDurationMs: 4000, ffmpegPath, log: silentLog });
  try {
    assert.ok(isBlue(await access.readFrameAt(1600)), '1.6s 파랑(영상 stream 의 마지막 격자)');
    assert.ok(isBlue(await access.readFrameAt(2400)), '영상 stream 끝 뒤 2.4s 도 마지막 화면');
    assert.ok(isBlue(await access.readFrameAt(3600)), '3.6s 도 마지막 화면');
    const buffer = await access.captureFrameJpeg({ timeMs: 3000 });
    assert.ok(buffer, '영상 stream 끝 뒤 캡처도 마지막 화면');
    const [r, , b] = await readJpegColor(buffer);
    assert.ok(b > 200 && r < 80, `마지막 화면은 파랑: ${r},${b}`);
    assert.deepEqual(access.getStats(), { captureCount: 1, captureFailCount: 0, captureFallbackCount: 1 });
  } finally {
    frameReader.close();
  }
});

test('격자 마지막 칸 뒤 시각(영상 끝 D 이후)은 마지막 격자 칸으로 당겨 읽는다', async () => {
  const filePath = await createTestClip({ dirPath, fileName: 'edge.mp4', colorTimeline: [['red', 1.72], ['blue', 2]], hasAudio: false });
  const clock = createVirtualClock();
  const requestList = [];
  const realReader = openSampleFrameReader({ filePath, ffmpegPath });
  const frameReader = { readFrameAt: (timeMs) => { requestList.push(timeMs); return realReader.readFrameAt(timeMs); }, close: () => realReader.close() };
  const access = createFrameAccess({ clock, frameReader, filePath, mediaDurationMs: 3720, ffmpegPath, log: silentLog });
  try {
    assert.ok(isBlue(await access.readFrameAt(3600)));
    assert.ok(isBlue(await access.readFrameAt(4000)), 'D 뒤 첫 tick');
    assert.ok(isBlue(await access.readFrameAt(4400)), 'D 뒤 둘째 tick');
    assert.deepEqual(requestList, [3600, 3600, 3600]);
  } finally {
    realReader.close();
  }
});

test('프레임 읽기가 실제 시간 상한을 넘으면 리더를 닫고 분명한 오류로 실패를 알린다(가상 시계가 hold 에 묶이지 않는다)', async () => {
  const clock = createVirtualClock();
  let closeCount = 0;
  const fatalList = [];
  const frameReader = { readFrameAt: () => new Promise(() => {}), close: () => { closeCount += 1; } };
  const access = createFrameAccess({
    clock, frameReader, filePath: shortVideoPath, mediaDurationMs: 4000, ffmpegPath, timeoutMs: 200, log: silentLog,
    onFatal: (error) => fatalList.push(error.message),
  });
  const startedAt = performance.now();
  await assert.rejects(access.readFrameAt(400), /프레임 읽기가 실제 0\.2초 안에 끝나지 않았다/);
  assert.ok(performance.now() - startedAt < 2000);
  assert.equal(closeCount, 1);
  assert.equal(fatalList.length, 1);
  assert.match(fatalList[0], /ffmpeg 가 멈춘 것으로 보고/);
  assert.equal(clock.holdCount, 0);
});

test('JPEG 캡처가 실제 시간 상한을 넘으면 그 ffmpeg 만 죽이고 null 을 주며 실패를 알린다', async () => {
  const clock = createVirtualClock();
  const hanging = await createHangingBinary();
  const fatalList = [];
  const access = createFrameAccess({
    clock, frameReader: { readFrameAt: async () => null, close() {} }, filePath: shortVideoPath, mediaDurationMs: 4000,
    ffmpegPath: hanging.scriptPath, timeoutMs: 1000, log: silentLog, onFatal: (error) => fatalList.push(error.message),
  });
  assert.equal(await access.captureFrameJpeg({ timeMs: 1000 }), null);
  assert.equal(fatalList.length, 1);
  assert.match(fatalList[0], /JPEG 캡처가 실제 1초 안에 끝나지 않았다/);
  const pid = hanging.readPid();
  assert.ok(await waitRealUntil(() => !isProcessAlive(pid)), `멈춘 캡처 프로세스(${pid})가 남았다`);
  assert.equal(clock.holdCount, 0);
});

test('JPEG 캡처가 오류로 끝나면 null 을 주고 실패 수를 센다(실패로 끝내지는 않는다)', async () => {
  const clock = createVirtualClock();
  const fatalList = [];
  const warnList = [];
  const access = createFrameAccess({
    clock, frameReader: { readFrameAt: async () => null, close() {} }, filePath: path.join(dirPath, 'missing.mp4'), mediaDurationMs: 4000,
    ffmpegPath, log: { log() {}, warn: (message) => warnList.push(message) }, onFatal: (error) => fatalList.push(error.message),
  });
  assert.equal(await access.captureFrameJpeg({ timeMs: 1000 }), null);
  assert.deepEqual(access.getStats(), { captureCount: 1, captureFailCount: 1, captureFallbackCount: 0 });
  assert.deepEqual(fatalList, []);
  assert.equal(warnList.length, 1);
  assert.match(warnList[0], /프레임 캡처 실패\(1000ms\)/);
});
