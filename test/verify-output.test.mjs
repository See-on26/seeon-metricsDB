import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeBestCorrelation, computeExpectedOutputMs, computePlayedAdMs, verifyOutput } from '../src/output/verify-output.mjs';
import { renderOutputMp3 } from '../src/output/render-mp3.mjs';
import { summarizeTimeline } from '../src/session/playback-recorder.mjs';
import { resolveFfmpegPaths, runBinary } from '../src/media/ffmpeg.mjs';
import { createTestClip } from './helpers/media-fixtures.mjs';

const { ffmpegPath, ffprobePath } = resolveFfmpegPaths({ env: process.env });
const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-verify-'));
after(() => fs.rmSync(dirPath, { recursive: true, force: true }));

test('AD 소리가 출력에 있으면 상관이 1 에 가깝고 지연(lag)도 찾는다', () => {
  const reference = Float32Array.from({ length: 4000 }, (_, i) => Math.sin(i * (0.01 + i * 0.00001)));
  const target = new Float32Array(4400);
  target.set(reference, 200);
  const { correlation, lagSamples } = computeBestCorrelation({ reference, target, maxLagSamples: 400 });
  assert.ok(correlation > 0.99);
  assert.equal(lagSamples, 200);
  let seed = 1;
  const noise = Float32Array.from({ length: 4400 }, () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; });
  assert.ok(computeBestCorrelation({ reference, target: noise, maxLagSamples: 400 }).correlation < 0.3);
});

test('기대 길이 = 원음 + AD + 무음 − 따라잡기 회수', () => {
  assert.equal(computeExpectedOutputMs({ report: { output: { sourceMediaMs: 60000, adTotalMs: 5000, silenceTotalMs: 40, recoveredMs: 7000 } } }), 58040);
});

test('AD 가 실제로 들린 길이: 끝까지 들리면 음성 길이, 끊기거나 세션 끝에 잘리면 타임라인의 AD 조각 길이, 조각이 없으면 null', () => {
  const timeline = [
    { kind: 'source', outStartMs: 0, outEndMs: 1000, srcStartMs: 0, srcEndMs: 1000 },
    { kind: 'ad', outStartMs: 1000, outEndMs: 2200, adRef: 1 },
    { kind: 'source', outStartMs: 2200, outEndMs: 3000, srcStartMs: 1000, srcEndMs: 1800 },
    { kind: 'ad', outStartMs: 3000, outEndMs: 3400, adRef: 2 },
  ];
  assert.equal(computePlayedAdMs({ ad: { captionSeq: 1, outputMs: 1000, durationMs: 1200 }, timeline }), 1200);
  assert.equal(computePlayedAdMs({ ad: { captionSeq: 2, outputMs: 3000, durationMs: 1500 }, timeline }), 400);
  assert.equal(computePlayedAdMs({ ad: { captionSeq: 3, outputMs: null, durationMs: 1500 }, timeline }), null);
});

// 쓸기음(chirp)은 주기가 없어 엉뚱한 지연에서 상관이 높게 나오지 않는다. 원음의 330Hz 사인과도 거의 상관이 없다.
async function createChirpWav({ filePath, durationSec, startHz, sweepHzPerSec }) {
  await runBinary({
    binaryPath: ffmpegPath,
    argList: ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc='0.3*sin(2*PI*(${startHz}*t+${sweepHzPerSec / 2}*t*t))':s=24000:d=${durationSec}`, '-c:a', 'pcm_s16le', filePath],
  });
}

// 원음(330Hz 사인 6초) 사이에 AD 두 개: ad-001 은 끝까지, ad-002 는 1250ms 중 400ms 만 들리고 끊긴다. 끝 1초는 1.5배속 따라잡기다.
const PASS_PIECE_LIST = [
  { kind: 'source', outStartMs: 0, outEndMs: 1500, srcStartMs: 0, srcEndMs: 1500 },
  { kind: 'silence', outStartMs: 1500, outEndMs: 1520 },
  { kind: 'ad', outStartMs: 1520, outEndMs: 2720, adRef: 1 },
  { kind: 'source', outStartMs: 2720, outEndMs: 4220, srcStartMs: 1500, srcEndMs: 3000 },
  { kind: 'ad', outStartMs: 4220, outEndMs: 4620, adRef: 2 },
  { kind: 'source', outStartMs: 4620, outEndMs: 6120, srcStartMs: 3000, srcEndMs: 4500 },
  { kind: 'source', outStartMs: 6120, outEndMs: 7120, srcStartMs: 4500, srcEndMs: 6000 },
];
// ad-001 자리에 AD 대신 원음이 이어진 출력. 길이는 같아 AD 검사만 실패해야 한다.
const MISSING_PIECE_LIST = PASS_PIECE_LIST.map((piece) => (piece.adRef === 1
  ? { kind: 'source', outStartMs: 1520, outEndMs: 2720, srcStartMs: 1500, srcEndMs: 2700 }
  : piece));

function buildMinimalReport({ outputFileName }) {
  const summary = summarizeTimeline(PASS_PIECE_LIST);
  return {
    output: {
      file: outputFileName, sourceMediaMs: summary.sourceMediaMs, adTotalMs: summary.adTotalMs,
      silenceTotalMs: summary.silenceTotalMs, recoveredMs: summary.recoveredMs,
    },
    adList: [
      { id: 'ad-001', captionSeq: 1, outputMs: 1520, durationMs: 1200, interruptedReason: null, wavFile: 'clip/ad/ad-001.wav' },
      { id: 'ad-002', captionSeq: 2, outputMs: 4220, durationMs: 1250, interruptedReason: 'interrupted', wavFile: 'clip/ad/ad-002.wav' },
    ],
    timeline: PASS_PIECE_LIST,
  };
}

async function prepareVerifyFixture() {
  const sourcePath = await createTestClip({ dirPath, fileName: 'clip.mp4', colorTimeline: [['black', 6]], audioExpr: '0.3*sin(2*PI*330*t)' });
  const adDir = path.join(dirPath, 'clip', 'ad');
  fs.mkdirSync(adDir, { recursive: true });
  const adPathByRef = new Map([[1, path.join(adDir, 'ad-001.wav')], [2, path.join(adDir, 'ad-002.wav')]]);
  await createChirpWav({ filePath: adPathByRef.get(1), durationSec: 1.2, startHz: 200, sweepHzPerSec: 800 });
  await createChirpWav({ filePath: adPathByRef.get(2), durationSec: 1.25, startHz: 1500, sweepHzPerSec: -800 });
  const renderOption = { sourcePath, hasSourceAudio: true, adPathByRef, workDir: dirPath, sampleRate: 48000, channelCount: 2, ffmpegPath };
  await renderOutputMp3({ ...renderOption, pieceList: PASS_PIECE_LIST, outPath: path.join(dirPath, 'clip_SEEON_AD.mp3') });
  await renderOutputMp3({ ...renderOption, pieceList: MISSING_PIECE_LIST, outPath: path.join(dirPath, 'missing_SEEON_AD.mp3') });
}

const fixturePromise = prepareVerifyFixture();

test('실제 mp3: 길이가 공식과 맞고 AD 두 개(끊긴 것은 들린 부분만)가 제자리에서 들리면 통과한다', async () => {
  await fixturePromise;
  const result = await verifyOutput({ outDir: dirPath, report: buildMinimalReport({ outputFileName: 'clip_SEEON_AD.mp3' }), ffmpegPath, ffprobePath });
  assert.equal(result.duration.expectedMs, 7120);
  assert.ok(Math.abs(result.duration.diffMs) <= 80, `mp3 ${result.duration.mp3Ms}ms`);
  assert.deepEqual(result.adCheckList.map((check) => [check.id, check.outputMs, check.playedMs]), [['ad-001', 1520, 1200], ['ad-002', 4220, 400]]);
  for (const check of result.adCheckList) assert.ok(check.correlation > 0.9, `${check.id} 상관 ${check.correlation}`);
  assert.equal(result.isOk, true);
});

test('실제 mp3: AD 자리에 원음이 이어져 AD 가 없으면 길이가 맞아도 실패한다', async () => {
  await fixturePromise;
  const result = await verifyOutput({ outDir: dirPath, report: buildMinimalReport({ outputFileName: 'missing_SEEON_AD.mp3' }), ffmpegPath, ffprobePath });
  assert.ok(Math.abs(result.duration.diffMs) <= 80, `mp3 ${result.duration.mp3Ms}ms`);
  const [missingCheck, interruptedCheck] = result.adCheckList;
  assert.equal(missingCheck.isOk, false);
  assert.ok(missingCheck.correlation < 0.3, `원음과의 상관 ${missingCheck.correlation}`);
  assert.equal(interruptedCheck.isOk, true);
  assert.equal(result.isOk, false);
});
