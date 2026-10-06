import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeMeterLevel, computeMeterLevelList, createMeterLevelAccumulator, decodeMeterLevelList, readLevelAt } from '../src/media/audio-levels.mjs';
import { planAsrSegmentList } from '../src/media/asr-segment-plan.mjs';
import { encodeVoicedSegmentList } from '../src/media/segment-encoder.mjs';
import { probeVideo } from '../src/media/probe.mjs';
import { readWavInfo } from '../src/media/wav.mjs';
import { resolveFfmpegPaths, runBinary } from '../src/media/ffmpeg.mjs';
import { createTestClip } from './helpers/media-fixtures.mjs';
import { createToneWav } from './helpers/mock-services.mjs';

const { ffmpegPath, ffprobePath } = resolveFfmpegPaths({ env: process.env });
const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-audio-'));

// [길이ms, 레벨] 목록 → 100ms tick 레벨 목록. tick k(시각 k×100)는 그 시각을 덮는 구간의 레벨이다.
// 임계값과 정확히 같은 0.02 를 담으려고 배정밀도로 만든다(Float32 에서는 0.0199999995 가 된다).
function levelListFrom(patternList, tickMs = 100) {
  const totalMs = patternList.reduce((sum, [ms]) => sum + ms, 0);
  const levelList = new Float64Array(Math.floor(totalMs / tickMs));
  for (let tick = 1; tick <= levelList.length; tick += 1) {
    let boundaryMs = 0;
    for (const [ms, level] of patternList) {
      boundaryMs += ms;
      if (tick * tickMs <= boundaryMs) { levelList[tick - 1] = level; break; }
    }
  }
  return levelList;
}

test('미터 레벨은 AnalyserNode 바이트 RMS 와 같다: 무음 0, 진폭 0.5 사인 ≈ 0.354', () => {
  const sampleRate = 48000;
  const sine = Float32Array.from({ length: sampleRate }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
  assert.equal(computeMeterLevel({ sampleList: new Float32Array(1024), endIndex: 1024, windowSize: 512 }), 0);
  assert.ok(Math.abs(computeMeterLevel({ sampleList: sine, endIndex: 24000, windowSize: 512 }) - 0.3536) < 0.01);
  assert.equal(computeMeterLevel({ sampleList: Float32Array.of(1, 1), endIndex: 2, windowSize: 2 }), 127 / 128, '⌊256⌋ 은 255 로 자른다');
});

test('나눠 넣어도 한 번에 계산한 레벨 목록과 같다', () => {
  const sampleList = Float32Array.from({ length: 48000 * 2 }, (_, i) => (i % 9600 < 4800 ? 0.3 : 0) * Math.sin(i / 7));
  const expected = computeMeterLevelList({ sampleList, sampleRate: 48000, tickMs: 100 });
  const accumulator = createMeterLevelAccumulator({ sampleRate: 48000, tickMs: 100, windowSize: 512 });
  for (let offset = 0; offset < sampleList.length; offset += 7777) accumulator.push(sampleList.subarray(offset, offset + 7777));
  assert.deepEqual(Array.from(accumulator.finish()), Array.from(expected));
  assert.equal(expected.length, 20);
  assert.equal(readLevelAt({ levelList: expected, timeMs: 0, tickMs: 100 }), 0, 'tick 0 은 없다');
});

test('계속 말하면 3초마다 타이머로 자른다', () => {
  const segmentList = planAsrSegmentList({ levelList: levelListFrom([[9000, 0.1]]), durationMs: 9000, segmentMs: 3000, minSegmentMs: 2500 });
  assert.deepEqual(segmentList.map(({ startMs, endMs, isVoiced }) => [startMs, endMs, isVoiced]),
    [[0, 3000, true], [3000, 6000, true], [6000, 9000, true]]);
});

test('2.5초가 지난 뒤 끝 무음 400ms 가 쌓인 tick 에서 자르고, 무성 조각은 isVoiced=false, 영상 끝은 마지막 조각', () => {
  const segmentList = planAsrSegmentList({ levelList: levelListFrom([[2000, 0.1], [4000, 0]]), durationMs: 6000, segmentMs: 3000, minSegmentMs: 2500 });
  assert.deepEqual(segmentList, [
    { startMs: 0, endMs: 2500, voicedMs: 2000, isVoiced: true },
    { startMs: 2500, endMs: 5500, voicedMs: 0, isVoiced: false },
    { startMs: 5500, endMs: 6000, voicedMs: 0, isVoiced: false },
  ]);
});

test('조각 VAD 는 레벨이 정확히 0.02 여도 말로 센다(>=)', () => {
  const segmentList = planAsrSegmentList({ levelList: levelListFrom([[3000, 0.02]]), durationMs: 3000, segmentMs: 3000, minSegmentMs: 2500 });
  assert.equal(segmentList[0].voicedMs, 3000);
});

test('조각 길이·tick·영상 길이가 0 이하이거나 유한수가 아니면 무한 루프 대신 바로 오류', () => {
  const baseOptionMap = { levelList: levelListFrom([[3000, 0.1]]), durationMs: 3000, segmentMs: 3000, minSegmentMs: 2500 };
  const badOptionList = [
    ['segmentMs', 0], ['segmentMs', -100], ['segmentMs', Number.NaN], ['segmentMs', Number.POSITIVE_INFINITY],
    ['tickMs', 0], ['tickMs', -100], ['tickMs', Number.NaN], ['tickMs', Number.POSITIVE_INFINITY],
    ['durationMs', -1], ['durationMs', Number.NaN], ['durationMs', Number.POSITIVE_INFINITY],
  ];
  for (const [name, value] of badOptionList) {
    assert.throws(() => planAsrSegmentList({ ...baseOptionMap, [name]: value }), RangeError, `${name}=${value}`);
  }
});

test('ffmpeg 로 레벨을 구한다: 1초 사인 뒤 무음', async () => {
  const filePath = await createTestClip({ dirPath, fileName: 'tone.mp4', colorTimeline: [['black', 3]], audioExpr: '0.5*sin(2*PI*440*t)*lt(t,1)' });
  const probe = await probeVideo({ filePath, ffprobePath });
  assert.equal(probe.hasAudio, true);
  assert.ok(Math.abs(probe.durationMs - 3000) < 100);
  const levelList = await decodeMeterLevelList({ filePath, probe, ffmpegPath });
  assert.ok(Math.abs(readLevelAt({ levelList, timeMs: 500 }) - 0.354) < 0.06);
  assert.ok(readLevelAt({ levelList, timeMs: 2000 }) < 0.02, '무음 구간은 말 임계 아래');
});

const TONE_EXPR = '0.5*sin(2*PI*440*t)';

// 바이트가 Buffer 풀 안의 아무 위치에 있어도 Float32Array 로 읽을 수 있게 복사한다.
const toFloat32List = (buffer) => new Float32Array(Uint8Array.from(buffer).buffer);

async function readAudioStartSec(filePath) {
  const output = await runBinary({ binaryPath: ffprobePath, argList: ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=start_time', '-of', 'csv=p=0', filePath] });
  return Number(output.toString('utf8').trim());
}

test('오디오 stream 이 늦게 시작해도 레벨 격자는 영상(컨테이너) 시각 0 기준이다', async () => {
  const filePath = await createTestClip({ dirPath, fileName: 'offset.mp4', colorTimeline: [['black', 3]], audioExpr: `${TONE_EXPR}*lt(t,1)`, audioStartSec: 1 });
  assert.ok(await readAudioStartSec(filePath) > 0.9, '테스트 영상의 오디오가 약 1초 늦게 시작해야 한다');
  const probe = await probeVideo({ filePath, ffprobePath });
  const levelList = await decodeMeterLevelList({ filePath, probe, ffmpegPath });
  assert.equal(levelList.length, 30, '길이는 영상 길이(3초)와 같다');
  assert.ok(readLevelAt({ levelList, timeMs: 500 }) < 0.02, '오디오가 시작하기 전은 무음');
  assert.ok(Math.abs(readLevelAt({ levelList, timeMs: 1500 }) - 0.354) < 0.06, '톤은 영상 1–2초에 있다');
  assert.ok(readLevelAt({ levelList, timeMs: 2500 }) < 0.02);
});

test('조각 인코딩도 영상 시각 기준이라 오디오가 시작하기 전 구간은 무음으로 들어간다', async () => {
  const filePath = await createTestClip({ dirPath, fileName: 'offset-encode.mp4', colorTimeline: [['black', 3]], audioExpr: `${TONE_EXPR}*lt(t,1)`, audioStartSec: 1 });
  const segmentList = [{ startMs: 0, endMs: 3000, voicedMs: 1000, isVoiced: true }];
  const bufferMap = await encodeVoicedSegmentList({ filePath, segmentList, ffmpegPath });
  const pcm = await runBinary({ binaryPath: ffmpegPath, argList: ['-v', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], inputBuffer: bufferMap.get(0) });
  const levelList = computeMeterLevelList({ sampleList: toFloat32List(pcm) });
  assert.ok(Math.abs(levelList.length - 30) <= 1, `조각 길이는 3초(${levelList.length} tick)`);
  assert.ok(readLevelAt({ levelList, timeMs: 500 }) < 0.02, '조각 앞 1초는 무음');
  assert.ok(readLevelAt({ levelList, timeMs: 1500 }) > 0.2, '톤은 조각 1–2초에 있다');
});

test('모노 96kHz 오디오도 48kHz 미터 격자로 같은 레벨을 낸다', async () => {
  const filePath = await createTestClip({ dirPath, fileName: 'mono96k.mp4', colorTimeline: [['black', 2]], audioExpr: TONE_EXPR, audioChannelCount: 1, audioSampleRate: 96000 });
  const probe = await probeVideo({ filePath, ffprobePath });
  assert.deepEqual([probe.audioChannelCount, probe.audioSampleRate], [1, 96000]);
  const levelList = await decodeMeterLevelList({ filePath, probe, ffmpegPath });
  assert.equal(levelList.length, 20);
  assert.ok(Math.abs(readLevelAt({ levelList, timeMs: 1000 }) - 0.354) < 0.06);
});

test('5.1 은 Web Audio speakers 다운믹스(√½·L + C + ½·SL, LFE 제외)대로 레벨을 낸다', async () => {
  const exprList = [`${TONE_EXPR}*lt(t,1)`, '0', `${TONE_EXPR}*between(t,1,2)`, `${TONE_EXPR}*between(t,3,4)`, `${TONE_EXPR}*between(t,2,3)`, '0'];
  const filePath = await createTestClip({ dirPath, fileName: 'surround.mp4', colorTimeline: [['black', 4]], audioExpr: exprList, audioChannelCount: 6 });
  const probe = await probeVideo({ filePath, ffprobePath });
  assert.equal(probe.audioChannelCount, 6);
  const levelList = await decodeMeterLevelList({ filePath, probe, ffmpegPath });
  assert.equal(levelList.length, 40);
  const toneLevel = 0.5 / Math.SQRT2;
  assert.ok(Math.abs(readLevelAt({ levelList, timeMs: 500 }) - toneLevel * Math.SQRT1_2) < 0.03, 'FL 은 √½');
  assert.ok(Math.abs(readLevelAt({ levelList, timeMs: 1500 }) - toneLevel) < 0.03, 'FC 는 1');
  assert.ok(Math.abs(readLevelAt({ levelList, timeMs: 2500 }) - toneLevel * 0.5) < 0.03, 'SL 은 ½');
  assert.ok(readLevelAt({ levelList, timeMs: 3500 }) < 0.02, 'LFE 는 빠진다');
});

test('ffmpeg 를 띄우지 못하면 프로세스를 죽이지 않고 거부한다', async () => {
  const probe = { durationMs: 1000, hasAudio: true, audioChannelCount: 2 };
  await assert.rejects(decodeMeterLevelList({ filePath: path.join(dirPath, 'none.mp4'), probe, ffmpegPath: path.join(dirPath, 'no-ffmpeg') }), { code: 'ENOENT' });
});

test('오디오 트랙이 없으면 레벨은 모두 0 이고 보낼 조각이 없다', async () => {
  const filePath = await createTestClip({ dirPath, fileName: 'silent.mp4', colorTimeline: [['gray', 3]], hasAudio: false });
  const probe = await probeVideo({ filePath, ffprobePath });
  assert.equal(probe.hasAudio, false);
  const levelList = await decodeMeterLevelList({ filePath, probe, ffmpegPath });
  assert.equal(levelList.length, 30);
  assert.ok(levelList.every((level) => level === 0));
  const segmentList = planAsrSegmentList({ levelList, durationMs: probe.durationMs, segmentMs: 3000, minSegmentMs: 2500 });
  assert.ok(segmentList.every((segment) => !segment.isVoiced));
});

test('말이 있는 조각만 webm/opus 로 인코딩한다', async () => {
  const filePath = await createTestClip({ dirPath, fileName: 'speech.mp4', colorTimeline: [['black', 6]], audioExpr: '0.4*sin(2*PI*220*t)*lt(t,3)' });
  const segmentList = [{ startMs: 0, endMs: 3000, voicedMs: 3000, isVoiced: true }, { startMs: 3000, endMs: 6000, voicedMs: 0, isVoiced: false }];
  const bufferMap = await encodeVoicedSegmentList({ filePath, segmentList, ffmpegPath });
  assert.deepEqual([...bufferMap.keys()], [0]);
  assert.equal(bufferMap.get(0).readUInt32BE(0), 0x1a45dfa3, 'EBML(webm) 머리');
});

test('WAV 길이를 읽는다', () => {
  assert.deepEqual(readWavInfo(createToneWav({ durationMs: 800 })), { durationMs: 800, sampleRate: 16000, channelCount: 1 });
  assert.equal(readWavInfo(Buffer.from('not a wav file at all, definitely not')), null);
});
