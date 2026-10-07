import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveOutputAudioFormat, buildPieceFilter, buildRenderChunkList } from '../src/output/render-plan.mjs';
import { renderOutputMp3 } from '../src/output/render-mp3.mjs';
import { REPORT_MODEL_CONFIG_KEY_LIST, buildAdReport, readPipelineRecordList } from '../src/output/ad-report.mjs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolveProductPath } from '../src/product/product-paths.mjs';
import { resolveFfmpegPaths, runBinary } from '../src/media/ffmpeg.mjs';
import { createTestClip } from './helpers/media-fixtures.mjs';
import { createToneWav } from './helpers/mock-services.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const { ffmpegPath, ffprobePath } = resolveFfmpegPaths({ env: process.env });
const dirPath = makeTempDir('factory-render-');

// mp3 를 f32 PCM 으로 풀어 채널마다 [fromSec, toSec) 구간 RMS 를 잰다.
async function readChannelRmsList({ filePath, channelCount, sampleRate = 48000, fromSec, toSec }) {
  const pcm = await runBinary({ binaryPath: ffmpegPath, argList: ['-v', 'error', '-i', filePath, '-ac', String(channelCount), '-ar', String(sampleRate), '-f', 'f32le', 'pipe:1'] });
  const sampleList = new Float32Array(Uint8Array.from(pcm).buffer);
  const fromIndex = Math.round(fromSec * sampleRate);
  const toIndex = Math.round(toSec * sampleRate);
  return Array.from({ length: channelCount }, (_, channel) => {
    let squareSum = 0;
    for (let i = fromIndex; i < toIndex; i += 1) squareSum += sampleList[i * channelCount + channel] ** 2;
    return Math.sqrt(squareSum / (toIndex - fromIndex));
  });
}

function readStreamFormat(filePath) {
  const [sampleRate, channelCount] = execFileSync(ffprobePath, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,channels', '-of', 'csv=p=0', filePath])
    .toString().trim().split(',').map(Number);
  return { sampleRate, channelCount };
}

test('mp3 형식: 48kHz 이하·2채널 이하로 맞춘다', () => {
  assert.deepEqual(resolveOutputAudioFormat({ sampleRate: 96000, channelCount: 6 }), { sampleRate: 48000, channelCount: 2, channelLayout: 'stereo' });
  assert.deepEqual(resolveOutputAudioFormat({ sampleRate: 44100, channelCount: 1 }), { sampleRate: 44100, channelCount: 1, channelLayout: 'mono' });
});

test('조각 필터: 원음은 자르고 배속(atempo)한 뒤 표본 수를 정확히 맞추고, 1배속은 atempo 를 넣지 않는다', () => {
  const sped = buildPieceFilter({ piece: { kind: 'source', outStartMs: 0, outEndMs: 1500, srcStartMs: 2000, srcEndMs: 4000 }, inputLabel: 's0', outputLabel: 'p0', seekMs: 2000, sampleRate: 48000, channelLayout: 'stereo' });
  assert.match(sped, /^\[s0\]atrim=start=0\.000000:end=2\.000000,asetpts=PTS-STARTPTS,atempo=1\.333333,/);
  assert.match(sped, /apad=whole_len=72000,atrim=end_sample=72000/);
  const normal = buildPieceFilter({ piece: { kind: 'source', outStartMs: 0, outEndMs: 1000, srcStartMs: 0, srcEndMs: 1000 }, inputLabel: 's0', outputLabel: 'p1', seekMs: 0, sampleRate: 48000, channelLayout: 'stereo' });
  assert.doesNotMatch(normal, /atempo/);
  assert.match(buildPieceFilter({ piece: { kind: 'silence', outStartMs: 0, outEndMs: 20 }, outputLabel: 'p2', sampleRate: 48000, channelLayout: 'mono' }), /^anullsrc=r=48000:cl=mono,atrim=end_sample=960/);
});

test('조각이 1000개면 100개씩 10청크로 나누고, 청크마다 원음을 그 구간 앞에서 열어 영상 시각에 맞춘 뒤 나눈다', () => {
  const pieceList = [];
  for (let i = 0; i < 1000; i += 1) pieceList.push({ kind: 'source', outStartMs: i * 1000, outEndMs: (i + 1) * 1000, srcStartMs: i * 1000, srcEndMs: (i + 1) * 1000 });
  const chunkList = buildRenderChunkList({ pieceList, sourcePath: '/v.mp4', hasSourceAudio: true, adPathByRef: new Map(), sampleRate: 48000, channelLayout: 'stereo' });
  assert.equal(chunkList.length, 10);
  assert.deepEqual(chunkList[3].inputArgList, ['-ss', '300.000', '-i', '/v.mp4']);
  assert.match(chunkList[3].filterScript, /^\[0:a\]aresample=async=1:first_pts=0,asplit=100/);
  assert.equal(chunkList[3].outDurationMs, 100000);
});

test('오디오 없는 영상의 원음 조각은 같은 길이 무음으로 채운다', () => {
  const [chunk] = buildRenderChunkList({
    pieceList: [{ kind: 'source', outStartMs: 0, outEndMs: 500, srcStartMs: 0, srcEndMs: 500 }],
    sourcePath: '/v.mp4', hasSourceAudio: false, adPathByRef: new Map(), sampleRate: 48000, channelLayout: 'stereo',
  });
  assert.deepEqual(chunk.inputArgList, []);
  assert.match(chunk.filterScript, /^anullsrc/);
});

test('조각 표본 수는 출력 시각 경계에서 재어 누적 오차가 없고, 한 표본도 안 되는 조각은 뺀다', () => {
  const pieceList = Array.from({ length: 10 }, (_, i) => ({ kind: 'silence', outStartMs: i * 7, outEndMs: (i + 1) * 7 }));
  pieceList.push({ kind: 'source', outStartMs: 70, outEndMs: 70.01, srcStartMs: 70, srcEndMs: 70.01 });
  const [chunk] = buildRenderChunkList({ pieceList, sourcePath: '/v.mp4', hasSourceAudio: true, adPathByRef: new Map(), sampleRate: 44100, channelLayout: 'mono' });
  const sampleCountList = [...chunk.filterScript.matchAll(/atrim=end_sample=(\d+)/g)].map((match) => Number(match[1]));
  assert.equal(sampleCountList.length, 10);
  assert.equal(sampleCountList.reduce((sum, count) => sum + count, 0), 3087, '조각마다 반올림하면 309×10=3090 이 된다');
  assert.equal(chunk.sampleCount, 3087);
  assert.deepEqual(chunk.inputArgList, []);
});

test('atempo 범위(0.5–100) 밖 배속의 원음 조각은 렌더 전에 오류로 알린다', () => {
  const stalled = { kind: 'source', outStartMs: 0, outEndMs: 500, srcStartMs: 1000, srcEndMs: 1000 };
  assert.throws(
    () => buildPieceFilter({ piece: stalled, inputLabel: 's0', outputLabel: 'p0', seekMs: 1000, sampleRate: 48000, channelLayout: 'stereo' }),
    /배속 0\.000000.*0\.5–100/,
  );
  assert.throws(() => buildRenderChunkList({
    pieceList: [{ kind: 'source', outStartMs: 0, outEndMs: 10, srcStartMs: 0, srcEndMs: 2000 }],
    sourcePath: '/v.mp4', hasSourceAudio: true, adPathByRef: new Map(), sampleRate: 48000, channelLayout: 'stereo',
  }), /배속 200\.000000/);
});

test('AD 음성이 WAV 가 아니면 채널 수를 몰라 합성하지 않고 거부한다', async () => {
  const adPath = path.join(dirPath, 'ad-not-wav.mp3');
  fs.writeFileSync(adPath, Buffer.from('ID3 이것은 WAV 가 아니다'.padEnd(200, '.')));
  await assert.rejects(renderOutputMp3({
    sourcePath: path.join(dirPath, 'unused.mp4'), hasSourceAudio: true, outPath: path.join(dirPath, 'not-wav.mp3'), workDir: dirPath,
    sampleRate: 48000, channelCount: 2, ffmpegPath, adPathByRef: new Map([[1, adPath]]), pieceList: [{ kind: 'ad', outStartMs: 0, outEndMs: 500, adRef: 1 }],
  }), /WAV/);
  assert.equal(fs.existsSync(path.join(dirPath, 'not-wav.mp3')), false);
});

test('원음 + 무음 + AD + 배속 원음을 이어 mp3 를 만들고 길이가 타임라인과 같다', async () => {
  const sourcePath = await createTestClip({ dirPath, fileName: 'src.mp4', colorTimeline: [['black', 6]], audioExpr: '0.3*sin(2*PI*330*t)' });
  const adPath = path.join(dirPath, 'ad-001.wav');
  fs.writeFileSync(adPath, createToneWav({ durationMs: 1000, frequencyHz: 880 }));
  const pieceList = [
    { kind: 'source', outStartMs: 0, outEndMs: 2000, srcStartMs: 0, srcEndMs: 2000 },
    { kind: 'silence', outStartMs: 2000, outEndMs: 2020 },
    { kind: 'ad', outStartMs: 2020, outEndMs: 3020, adRef: 1 },
    { kind: 'source', outStartMs: 3020, outEndMs: 4520, srcStartMs: 2000, srcEndMs: 4000 },
    { kind: 'source', outStartMs: 4520, outEndMs: 6520, srcStartMs: 4000, srcEndMs: 6000 },
  ];
  const outPath = path.join(dirPath, 'src_SEEON_AD.mp3');
  const { durationMs } = await renderOutputMp3({
    sourcePath, hasSourceAudio: true, pieceList, adPathByRef: new Map([[1, adPath]]), outPath, workDir: dirPath,
    sampleRate: 48000, channelCount: 2, ffmpegPath,
  });
  assert.equal(durationMs, 6520);
  const probedMs = Number(execFileSync(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outPath]).toString()) * 1000;
  assert.ok(Math.abs(probedMs - 6520) < 80, `mp3 ${probedMs}ms`);
  assert.equal(fs.readdirSync(dirPath).some((name) => name.startsWith('render-')), false, '중간 파일을 지운다');
});

test('렌더 중 워커가 죽어 남은 render-* 임시 파일은 다음 렌더가 지우고, 작업 폴더의 다른 파일은 그대로 둔다', async () => {
  const workDir = makeTempDir('factory-render-leftover-');
  const sourcePath = await createTestClip({ dirPath: workDir, fileName: 'src.mp4', colorTimeline: [['black', 1]], audioExpr: '0.3*sin(2*PI*330*t)' });
  fs.mkdirSync(path.join(workDir, 'ad'));
  fs.writeFileSync(path.join(workDir, 'ad', 'ad-001.wav'), createToneWav({ durationMs: 300 }));
  fs.writeFileSync(path.join(workDir, 'render-0.wav'), Buffer.alloc(1024));
  fs.writeFileSync(path.join(workDir, 'render-list.txt'), "file 'render-0.wav'");
  fs.mkdirSync(path.join(workDir, 'render-AbCd12'));
  fs.writeFileSync(path.join(workDir, 'render-AbCd12', 'chunk-0.wav'), Buffer.alloc(1024));
  await renderOutputMp3({
    sourcePath, hasSourceAudio: true, pieceList: [{ kind: 'source', outStartMs: 0, outEndMs: 1000, srcStartMs: 0, srcEndMs: 1000 }], adPathByRef: new Map(),
    outPath: path.join(workDir, 'out.mp3'), workDir, sampleRate: 48000, channelCount: 2, ffmpegPath,
  });
  assert.deepEqual(fs.readdirSync(workDir).sort(), ['ad', 'out.mp3', 'src.mp4']);
  assert.deepEqual(fs.readdirSync(path.join(workDir, 'ad')), ['ad-001.wav']);
});

test('원음 오디오가 늦게 시작하는 영상도 영상(컨테이너) 시각에 맞춰 합성한다', async () => {
  const sourcePath = await createTestClip({ dirPath, fileName: 'late-audio.mp4', colorTimeline: [['black', 3]], audioExpr: '0.3*sin(2*PI*330*t)', audioStartSec: 1 });
  const outPath = path.join(dirPath, 'late-audio.mp3');
  await renderOutputMp3({
    sourcePath, hasSourceAudio: true, outPath, workDir: dirPath, sampleRate: 48000, channelCount: 2, ffmpegPath, adPathByRef: new Map(),
    pieceList: [
      { kind: 'source', outStartMs: 0, outEndMs: 1500, srcStartMs: 0, srcEndMs: 1500 },
      { kind: 'silence', outStartMs: 1500, outEndMs: 2000 },
      { kind: 'source', outStartMs: 2000, outEndMs: 3500, srcStartMs: 1500, srcEndMs: 3000 },
    ],
  });
  const [silentRms] = await readChannelRmsList({ filePath: outPath, channelCount: 1, fromSec: 0.1, toSec: 0.9 });
  const [toneRms] = await readChannelRmsList({ filePath: outPath, channelCount: 1, fromSec: 1.1, toSec: 1.4 });
  const [laterToneRms] = await readChannelRmsList({ filePath: outPath, channelCount: 1, fromSec: 2.1, toSec: 3.3 });
  assert.ok(silentRms < 0.01, `오디오가 시작하기 전(영상 0–1초)은 무음이어야 한다: ${silentRms}`);
  assert.ok(toneRms > 0.15 && laterToneRms > 0.15, `톤은 영상 1초 뒤에 있다: ${toneRms}, ${laterToneRms}`);
});

test('6ch·96kHz 원음은 stereo·48kHz mp3 로 합성한다', async () => {
  const sourcePath = await createTestClip({ dirPath, fileName: 'surround96k.mp4', colorTimeline: [['black', 2]], audioExpr: '0.3*sin(2*PI*330*t)', audioChannelCount: 6, audioSampleRate: 96000 });
  const adPath = path.join(dirPath, 'ad-surround.wav');
  fs.writeFileSync(adPath, createToneWav({ durationMs: 500, frequencyHz: 880 }));
  const outPath = path.join(dirPath, 'surround96k.mp3');
  const { durationMs } = await renderOutputMp3({
    sourcePath, hasSourceAudio: true, outPath, workDir: dirPath, sampleRate: 96000, channelCount: 6, ffmpegPath, adPathByRef: new Map([[1, adPath]]),
    pieceList: [
      { kind: 'source', outStartMs: 0, outEndMs: 1000, srcStartMs: 0, srcEndMs: 1000 },
      { kind: 'ad', outStartMs: 1000, outEndMs: 1500, adRef: 1 },
      { kind: 'source', outStartMs: 1500, outEndMs: 2500, srcStartMs: 1000, srcEndMs: 2000 },
    ],
  });
  assert.equal(durationMs, 2500);
  assert.deepEqual(readStreamFormat(outPath), { sampleRate: 48000, channelCount: 2 });
});

test('모노 AD 는 스테레오 출력의 두 채널에 원래 크기로 넣는다(Web Audio speakers 업믹스)', async () => {
  const adPath = path.join(dirPath, 'ad-mono.wav');
  fs.writeFileSync(adPath, createToneWav({ durationMs: 1000, frequencyHz: 880 }));
  const outPath = path.join(dirPath, 'mono-ad.mp3');
  await renderOutputMp3({
    sourcePath: path.join(dirPath, 'unused.mp4'), hasSourceAudio: true, outPath, workDir: dirPath, sampleRate: 48000, channelCount: 2, ffmpegPath,
    adPathByRef: new Map([[1, adPath]]), pieceList: [{ kind: 'ad', outStartMs: 0, outEndMs: 1000, adRef: 1 }],
  });
  const toneRms = (9000 / 32768) / Math.SQRT2;
  const rmsList = await readChannelRmsList({ filePath: outPath, channelCount: 2, fromSec: 0.2, toSec: 0.8 });
  for (const rms of rmsList) assert.ok(Math.abs(rms / toneRms - 1) < 0.05, `채널 RMS ${rms} ≈ ${toneRms}(−3dB 면 ${toneRms * Math.SQRT1_2})`);
});

test('AD 기록: 실험실 ad-timeline 이름 + 출력 시각·틈·호출 모델·버린 사유(main·렌더러·미재생)', () => {
  const sessionStartWallMs = 1_800_000_000_000;
  const report = buildAdReport({
    video: { videoId: 'v1', file: '/v1.mp4', durationMs: 30000, width: 1920, height: 1080, language: 'ko' },
    seeonMeet: { commit: 'c0ebca0', isDirty: false }, config: { mode: 'delayed', isEvalPreset: true, isPageTransitionIncluded: false },
    sessionStartWallMs,
    pieceList: [
      { kind: 'source', outStartMs: 0, outEndMs: 5000, srcStartMs: 0, srcEndMs: 5000 },
      { kind: 'ad', outStartMs: 5000, outEndMs: 6500, adRef: 1 },
      { kind: 'source', outStartMs: 6500, outEndMs: 29000, srcStartMs: 5000, srcEndMs: 30000 },
    ],
    captionRecordList: [
      { captionSeq: 1, ts: sessionStartWallMs + 4000, text: '막대 그래프 상승', source: 'deixis', narrationClass: 'deixis', slideLabel: '1', eventVideoTimeMs: 3000, rationale: { utterance: '이 그래프를 보시면', summary: '근거 표현=이 그래프' }, insertVideoTimeMs: 5000, audioDurationMs: 1500, gap: { source: 'bedrock', reason: '문장 끝', gapIndex: 0, candidateCount: 2, callList: [] }, callList: [{ service: 'bedrock', modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', isVlmFallback: true, status: 200, elapsedMs: 900 }],
        tts: { isOk: true, isOnDemand: true, requestedAtMs: 15000, elapsedMs: 480, message: null, callList: [{ service: 'tts', modelId: null, isVlmFallback: false, status: 200, elapsedMs: 470 }] }, ttsWaitMs: 480 },
      { captionSeq: 2, ts: sessionStartWallMs + 9000, text: '못 들은 해설', source: 'deixis', narrationClass: 'deixis', slideLabel: '1', eventVideoTimeMs: 8000, rationale: null, insertVideoTimeMs: 8000, audioDurationMs: 1000, gap: null, callList: [],
        tts: { isOk: true, isOnDemand: false, requestedAtMs: 16000, elapsedMs: 300, message: null, callList: [] }, ttsWaitMs: null },
      { captionSeq: 3, ts: sessionStartWallMs + 20000, text: '정지 때 합성 중', source: 'deixis', narrationClass: 'deixis', slideLabel: '1', eventVideoTimeMs: 19000, rationale: null, insertVideoTimeMs: 19000, audioDurationMs: null, gap: null, callList: [],
        tts: { isOk: false, isSettled: false, isPendingAtStop: true, isOnDemand: true, requestedAtMs: 40000, elapsedMs: null, message: null, callList: [] }, ttsWaitMs: null },
    ],
    adPlayList: [{ captionSeq: 1, atElapsedMs: 15000, durationMs: 1500, playedMediaMs: 5000 }],
    dropRecordList: [{ captionSeq: 3, ts: sessionStartWallMs + 20000, text: '정지 때 합성 중', source: 'deixis', narrationClass: 'deixis', slideLabel: '1', eventVideoTimeMs: 19000, reason: 'stopped', factoryReason: 'drain_timeout', waitedMs: null }],
    pipelineRecordList: [{ kind: 'narration', ts: sessionStartWallMs + 12000, source: 'deixis', text: '간격 억제된 해설', slideLabel: '1', isEmitted: false, skipReason: 'rate-limited' }],
    callLog: [
      { service: 'asr', elapsedMs: 300, status: 200, errorMessage: null },
      { service: 'judge', modelId: 'qwen', elapsedMs: 400, status: 200, errorMessage: null },
      { service: 'vlm', modelId: 'qwen', elapsedMs: 1200, status: 200, errorMessage: null },
    ],
    judgeSourceCountMap: { router: { gpu: 1, bedrock: 0, error: 0 }, silence: { gpu: 0, bedrock: 0, error: 0 }, deixis: { gpu: 0, bedrock: 0, error: 0 } },
    triggerAnalyzerCountMap: { kiwi: 5, english: 1 },
    adFileByRef: new Map([[1, 'v1/ad/ad-001.wav']]), outputFileName: 'v1_SEEON_AD.mp3', renderedDurationMs: 29000, processingMs: 10000,
  });
  assert.equal(report.isComplete, true);
  assert.equal(report.adList.length, 1);
  const [ad] = report.adList;
  assert.deepEqual([ad.id, ad.type, ad.aid, ad.eventMediaMs, ad.insertMediaMs, ad.playedMediaMs, ad.outputMs, ad.durationMs, ad.latencyMs], ['ad-001', 'deixis', 'A2', 3000, 5000, 5000, 5000, 1500, 2000]);
  assert.equal(ad.trigger.anchor, '이 그래프');
  assert.equal(ad.isVlmFallback, true);
  assert.equal(ad.wavFile, 'v1/ad/ad-001.wav');
  // 재생 차례가 와서 합성했고(미리 만들지 못함) 그동안 480ms 무음이었다. TTS 호출도 AD 의 서비스 호출에 든다.
  assert.deepEqual(ad.tts, { isPrefetched: false, synthMs: 480, waitMs: 480 });
  assert.deepEqual(ad.serviceCallList.map((call) => call.service), ['bedrock', 'tts']);
  assert.deepEqual(report.droppedList.map((drop) => [drop.text, drop.reason, drop.eventMediaMs]),
    [['못 들은 해설', 'not_played', 8000], ['간격 억제된 해설', 'rate-limited', 12000], ['정지 때 합성 중', 'stopped', 19000]]);
  // 세션을 멈출 때 끝나지 않은 합성은 성공·실패에 넣지 않고 따로 센다.
  assert.deepEqual(report.stats.tts, { requestCount: 3, okCount: 2, failCount: 0, pendingAtStopCount: 1, onDemandCount: 2, unplayedOkCount: 1 });
  assert.deepEqual(report.stats.triggerAnalyzerCountMap, { kiwi: 5, english: 1 });
  assert.equal(report.output.recoveredMs, 2500);
  assert.equal(report.stats.serviceMap.asr.count, 1);
  assert.deepEqual([report.stats.serviceMap.judge.count, report.stats.serviceMap.vlm.count], [1, 1], '판정 호출은 VLM 과 따로 센다');
  assert.deepEqual(report.stats.judgeSourceCountMap.router, { gpu: 1, bedrock: 0, error: 0 });
  assert.equal(report.stats.realtimeFactor, 3);
});

test('AD 기록: 렌더러 드롭은 그 사유로, 사건 영상 시각이 없으면 실험실처럼 ts 로 잰다, 지시 판정 근거를 붙인다', () => {
  const sessionStartWallMs = 1_800_000_000_000;
  const report = buildAdReport({
    video: { videoId: 'v2', file: '/v2.mp4', durationMs: 20000, width: 1280, height: 720, language: 'ko' },
    seeonMeet: { commit: 'c0ebca0', isDirty: false }, config: { mode: 'delayed', isEvalPreset: true, isPageTransitionIncluded: true },
    sessionStartWallMs,
    pieceList: [
      { kind: 'source', outStartMs: 0, outEndMs: 4000, srcStartMs: 0, srcEndMs: 4000 },
      { kind: 'ad', outStartMs: 4000, outEndMs: 5000, adRef: 3 },
      { kind: 'source', outStartMs: 5000, outEndMs: 21000, srcStartMs: 4000, srcEndMs: 20000 },
    ],
    captionRecordList: [
      { captionSeq: 1, ts: sessionStartWallMs + 2000, text: '전환 고지', source: 'page-transition', narrationClass: 'page_transition', slideLabel: '2', eventVideoTimeMs: null, rationale: null, insertVideoTimeMs: null, gap: null, callList: [] },
      { captionSeq: 3, ts: sessionStartWallMs + 3500, text: '여기 표', source: 'deixis', narrationClass: 'deixis', slideLabel: '2', eventVideoTimeMs: 3000, rationale: { summary: '근거 표현=(없음)' }, insertVideoTimeMs: 4000, gap: null, callList: [] },
    ],
    adPlayList: [{ captionSeq: 3, atElapsedMs: 4000, durationMs: 1000, playedMediaMs: 4000 }],
    dropRecordList: [
      { captionSeq: 1, ts: sessionStartWallMs + 2000, text: '전환 고지', source: 'page-transition', narrationClass: 'page_transition', slideLabel: '2', eventVideoTimeMs: null, reason: 'dwell_cancelled', factoryReason: null, waitedMs: null },
      { captionSeq: 4, ts: sessionStartWallMs + 19000, text: '끝 뒤 해설', source: 'deixis', narrationClass: 'deixis', slideLabel: '2', eventVideoTimeMs: 19500, reason: 'stopped', factoryReason: 'after_end', waitedMs: null },
    ],
    pipelineRecordList: [{ kind: 'deixis', ts: sessionStartWallMs + 3500, caption: '여기 표', utterance: '여기 표를 보면', judgeReason: '지시어+표' }],
    callLog: [], adFileByRef: new Map([[3, 'v2/ad/ad-001.wav']]), outputFileName: 'v2_SEEON_AD.mp3', renderedDurationMs: 21000, processingMs: 0,
  });
  assert.deepEqual(report.droppedList, [
    { text: '전환 고지', type: 'page_transition', narrationClass: 'page_transition', slideLabel: '2', eventMediaMs: 2000, reason: 'dwell_cancelled', factoryReason: null },
    { text: '끝 뒤 해설', type: 'deixis', narrationClass: 'deixis', slideLabel: '2', eventMediaMs: 19500, reason: 'stopped', factoryReason: 'after_end' },
  ], '버린 사유는 제품 사유이고, 세션을 멈춰 버린 해설만 공장 사유를 더한다');
  assert.deepEqual(report.adList[0].tts, null, '합성 기록이 없는 해설');
  assert.deepEqual(report.stats.tts, { requestCount: 0, okCount: 0, failCount: 0, pendingAtStopCount: 0, onDemandCount: 0, unplayedOkCount: 0 });
  assert.equal(report.stats.triggerAnalyzerCountMap, null);
  const [ad] = report.adList;
  assert.deepEqual(ad.trigger, { utterance: '여기 표를 보면', anchor: null, judgeReason: '지시어+표' });
  assert.equal(ad.latencyMs, 1000);
  assert.equal(report.stats.realtimeFactor, null);
  assert.equal(report.stats.judgeSourceCountMap, null, '판정 집계를 받지 않으면 null');
  assert.deepEqual(report.output, { file: 'v2_SEEON_AD.mp3', renderedDurationMs: 21000, timelineDurationMs: 21000, sourceMediaMs: 20000, adTotalMs: 1000, silenceTotalMs: 0, recoveredMs: 0 });
});

test('AD 기록: 재생된 뒤 끊긴 해설은 실험실처럼 버린 목록이 아니라 AD 항목의 interruptedReason 으로 남긴다', () => {
  const sessionStartWallMs = 1_800_000_000_000;
  const captionList = [
    { captionSeq: 1, ts: sessionStartWallMs + 1000, text: '끊긴 해설', source: 'deixis', narrationClass: 'deixis', slideLabel: '1', eventVideoTimeMs: 1000, rationale: null, insertVideoTimeMs: 1000, gap: null, callList: [] },
    { captionSeq: 2, ts: sessionStartWallMs + 6000, text: '끝까지 들린 해설', source: 'deixis', narrationClass: 'deixis', slideLabel: '1', eventVideoTimeMs: 6000, rationale: null, insertVideoTimeMs: 6000, gap: null, callList: [] },
  ];
  const report = buildAdReport({
    video: { videoId: 'v3', file: '/v3.mp4', durationMs: 10000, width: 1280, height: 720, language: 'ko' },
    seeonMeet: { commit: 'c0ebca0', isDirty: false }, config: { mode: 'delayed', isEvalPreset: true, isPageTransitionIncluded: false },
    sessionStartWallMs,
    pieceList: [
      { kind: 'source', outStartMs: 0, outEndMs: 1000, srcStartMs: 0, srcEndMs: 1000 },
      { kind: 'ad', outStartMs: 1000, outEndMs: 1400, adRef: 1 },
      { kind: 'source', outStartMs: 1400, outEndMs: 6400, srcStartMs: 1000, srcEndMs: 6000 },
      { kind: 'ad', outStartMs: 6400, outEndMs: 7400, adRef: 2 },
      { kind: 'source', outStartMs: 7400, outEndMs: 11400, srcStartMs: 6000, srcEndMs: 10000 },
    ],
    captionRecordList: captionList,
    adPlayList: [{ captionSeq: 1, atElapsedMs: 1000, durationMs: 2000, playedMediaMs: 1000 }, { captionSeq: 2, atElapsedMs: 6400, durationMs: 1000, playedMediaMs: 6000 }],
    dropRecordList: [{ captionSeq: 1, ts: sessionStartWallMs + 1000, text: '끊긴 해설', source: 'deixis', narrationClass: 'deixis', slideLabel: '1', eventVideoTimeMs: 1000, reason: 'interrupted', waitedMs: null }],
    pipelineRecordList: [], callLog: [], adFileByRef: new Map(), outputFileName: 'v3_SEEON_AD.mp3', renderedDurationMs: 11400, processingMs: 5000,
  });
  assert.deepEqual(report.adList.map((ad) => [ad.text, ad.interruptedReason]), [['끊긴 해설', 'interrupted'], ['끝까지 들린 해설', null]]);
  assert.deepEqual(report.droppedList, []);
});

test('파이프라인 기록은 줄마다 JSON 으로 읽고 깨진 줄·없는 파일은 건너뛴다', () => {
  const recordPath = path.join(dirPath, 'pipeline-records.jsonl');
  fs.writeFileSync(recordPath, `${JSON.stringify({ kind: 'narration', ts: 1 })}\n{깨진 줄\n\n${JSON.stringify({ kind: 'deixis', ts: 2 })}\n`);
  assert.deepEqual(readPipelineRecordList({ recordPath }).map((record) => record.kind), ['narration', 'deixis']);
  assert.deepEqual(readPipelineRecordList({ recordPath: path.join(dirPath, 'none.jsonl') }), []);
  assert.deepEqual(readPipelineRecordList({ recordPath: null }), []);
});

test('AD 기록: 모델 설정은 허용 목록의 이름만 남겨 제품이 키·토큰 필드를 더해도 기록에 실리지 않고, 주소의 사용자 정보는 지운다', () => {
  const { readPipelineConfig } = createRequire(import.meta.url)(resolveProductPath('src/main/caption-pipeline/config.js'));
  const productConfig = readPipelineConfig({ AWS_BEARER_TOKEN_BEDROCK: 'secret-bearer', SEEON_ASR_URL: 'http://user:secret-pass@127.0.0.1:8802/asr' });
  const unknownFieldMap = { newServiceApiKey: 'secret-key', gpuAccessToken: 'secret-token', futureSetting: 'secret-unknown' };
  const report = buildAdReport({
    video: { videoId: 'v1', file: '/v1.mp4', durationMs: 1000, width: 320, height: 180, language: 'ko' },
    seeonMeet: { commit: 'c0ebca0', isDirty: false }, config: { mode: 'delayed', modelConfig: { ...productConfig, ...unknownFieldMap } },
    sessionStartWallMs: 0, pieceList: [{ kind: 'source', outStartMs: 0, outEndMs: 1000, srcStartMs: 0, srcEndMs: 1000 }],
    captionRecordList: [], adPlayList: [], dropRecordList: [], pipelineRecordList: [], callLog: [],
    adFileByRef: new Map(), outputFileName: 'v1_SEEON_AD.mp3', renderedDurationMs: 1000, processingMs: 100,
  });
  const reportedConfig = report.config.modelConfig;
  assert.deepEqual(Object.keys(reportedConfig).sort(), [...REPORT_MODEL_CONFIG_KEY_LIST].sort());
  assert.equal(reportedConfig.asrUrl, 'http://127.0.0.1:8802/asr');
  assert.equal(reportedConfig.vlmUrl, productConfig.vlmUrl, '사용자 정보가 없는 주소는 그대로');
  assert.deepEqual(reportedConfig.gapModelByModeMap, productConfig.gapModelByModeMap);
  assert.equal(reportedConfig.hasBedrockCredentials, true);
  assert.equal(JSON.stringify(report).includes('secret'), false);
  // 제품 설정에 새 필드가 생기면 여기서 알린다. 비밀이 아니면 허용 목록에 더하고, 비밀이면 아래 목록에 더한다.
  assert.deepEqual(Object.keys(productConfig).filter((key) => !REPORT_MODEL_CONFIG_KEY_LIST.includes(key)), ['bedrockApiKey']);
});

test('AD 기록: 모델 설정이 없는 기록은 그대로 둔다', () => {
  const report = buildAdReport({
    video: { videoId: 'v1', file: '/v1.mp4', durationMs: 1000, width: 320, height: 180, language: 'ko' },
    seeonMeet: { commit: 'c0ebca0', isDirty: false }, config: { mode: 'delayed' },
    sessionStartWallMs: 0, pieceList: [{ kind: 'source', outStartMs: 0, outEndMs: 1000, srcStartMs: 0, srcEndMs: 1000 }],
    captionRecordList: [], adPlayList: [], dropRecordList: [], pipelineRecordList: [], callLog: [],
    adFileByRef: new Map(), outputFileName: 'v1_SEEON_AD.mp3', renderedDurationMs: 1000, processingMs: 100,
  });
  assert.deepEqual(report.config, { mode: 'delayed' });
});
