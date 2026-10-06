import path from 'node:path';
import { runBinary } from '../media/ffmpeg.mjs';
import { PIECE_KIND_MAP } from '../session/playback-recorder.mjs';

// mp3 길이가 공식에서 이만큼까지 벗어나도 맞는 것으로 본다.
const DURATION_TOLERANCE_MS = 1000;
// mp3 인코더 지연·입력 탐색(-ss) 오차로 AD 가 기록된 출력 시각에서 앞뒤로 이만큼까지 어긋나도 찾는다.
const MAX_LAG_MS = 100;
// 비교 표본율. 말소리 대역(4kHz 이하)만으로 AD 를 알아볼 수 있고 상호상관 계산이 가볍다.
const VERIFY_SAMPLE_RATE = 8000;

const toSampleCount = (ms, sampleRate) => Math.round((ms * sampleRate) / 1000);
const roundTo3 = (value) => Math.round(value * 1000) / 1000;

// 출력 길이 = 들려준 원음의 원본 길이 + AD 합 + 무음 합 − 따라잡기로 줄인 시간.
// 세션이 배출 상한에 걸려 원음이 영상 끝까지 가지 않았어도 같은 식이다(sourceMediaMs 가 실제로 들려준 만큼이다).
export function computeExpectedOutputMs({ report }) {
  const { sourceMediaMs, adTotalMs, silenceTotalMs, recoveredMs } = report.output;
  return sourceMediaMs + adTotalMs + silenceTotalMs - recoveredMs;
}

// AD 가 출력에서 실제로 들린 길이. 합성은 AD 음성을 배속하지 않고, 타임라인의 AD 조각 길이만큼 앞부분만 남기거나 모자라면 무음으로 채운다.
// 그래서 질문 답에 끊겼거나 세션 끝에 잘린 AD 는 조각 길이만큼, 끝까지 들린 AD 는 음성 길이만큼만 출력에 있다.
// 출력 시각에 AD 조각이 없으면 출력에 없는 AD 라 null 이다.
export function computePlayedAdMs({ ad, timeline }) {
  const piece = timeline.find((item) => item.kind === PIECE_KIND_MAP.ad && item.adRef === ad.captionSeq && item.outStartMs === ad.outputMs);
  if (!piece) return null;
  const pieceMs = piece.outEndMs - piece.outStartMs;
  return Number.isFinite(ad.durationMs) ? Math.min(ad.durationMs, pieceMs) : pieceMs;
}

// 정규화 상호상관의 최댓값과 그때의 지연(표본 수). target 안에서 reference 를 0…maxLagSamples 만큼 밀어 가며 잰다.
export function computeBestCorrelation({ reference, target, maxLagSamples }) {
  let best = { correlation: -1, lagSamples: 0 };
  const referenceEnergy = reference.reduce((sum, value) => sum + value * value, 0);
  for (let lag = 0; lag <= maxLagSamples && lag + reference.length <= target.length; lag += 1) {
    let dot = 0;
    let targetEnergy = 0;
    for (let i = 0; i < reference.length; i += 1) {
      const value = target[lag + i];
      dot += reference[i] * value;
      targetEnergy += value * value;
    }
    const correlation = referenceEnergy && targetEnergy ? dot / Math.sqrt(referenceEnergy * targetEnergy) : 0;
    if (correlation > best.correlation) best = { correlation, lagSamples: lag };
  }
  return best;
}

// 파일의 [startMs, startMs + durationMs) 구간을 모노 f32 PCM 으로 푼다. durationMs 가 null 이면 끝까지 푼다.
export async function decodeMonoPcm({ filePath, startMs = 0, durationMs = null, sampleRate = VERIFY_SAMPLE_RATE, ffmpegPath }) {
  const durationArgList = durationMs === null ? [] : ['-t', (durationMs / 1000).toFixed(3)];
  const argList = ['-v', 'error', '-ss', (startMs / 1000).toFixed(3), ...durationArgList, '-i', filePath, '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', 'pipe:1'];
  const buffer = await runBinary({ binaryPath: ffmpegPath, argList });
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength - (buffer.byteLength % 4)));
}

async function probeDurationMs({ filePath, ffprobePath }) {
  const output = await runBinary({ binaryPath: ffprobePath, argList: ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath] });
  return Number(output.toString('utf8').trim()) * 1000;
}

// AD 음성의 들린 부분이 mp3 의 그 출력 시각에 그대로 있는지 상호상관으로 잰다. 교차 모드라 그 자리에는 원음이 섞이지 않는다.
// 기준은 음성 파일의 앞 playedMs 뿐이라 끊기거나 잘린 AD 도 들린 만큼만 견준다. 출력 맨 앞의 AD 는 앞쪽 여유가 줄어든다.
async function checkAdPlacement({ ad, timeline, outDir, mp3Path, ffmpegPath, correlationThreshold }) {
  const playedMs = computePlayedAdMs({ ad, timeline });
  const baseCheck = { id: ad.id, outputMs: ad.outputMs, playedMs };
  // 출력에 AD 조각이 없거나 음성 파일 기록이 없으면 AD 가 들리는지 확인할 수 없어 실패로 둔다.
  if (!(playedMs > 0) || !ad.wavFile) return { ...baseCheck, correlation: null, offsetMs: null, isOk: false };
  const reference = await decodeMonoPcm({ filePath: path.join(outDir, ad.wavFile), durationMs: playedMs, ffmpegPath });
  const windowStartMs = Math.max(0, ad.outputMs - MAX_LAG_MS);
  const leadMs = ad.outputMs - windowStartMs;
  const target = await decodeMonoPcm({ filePath: mp3Path, startMs: windowStartMs, durationMs: leadMs + playedMs + MAX_LAG_MS, ffmpegPath });
  const { correlation, lagSamples } = computeBestCorrelation({ reference, target, maxLagSamples: toSampleCount(leadMs + MAX_LAG_MS, VERIFY_SAMPLE_RATE) });
  return {
    ...baseCheck, correlation: roundTo3(correlation), offsetMs: Math.round((lagSamples * 1000) / VERIFY_SAMPLE_RATE - leadMs),
    isOk: correlation >= correlationThreshold,
  };
}

// 출력 mp3 를 기록 JSON 과 견준다: 길이가 공식과 허용 오차 안에서 맞는지, AD 마다 그 출력 시각에 AD 소리가 있는지.
export async function verifyOutput({ outDir, report, ffmpegPath, ffprobePath, correlationThreshold = 0.6 }) {
  const mp3Path = path.join(outDir, report.output.file);
  const mp3Ms = await probeDurationMs({ filePath: mp3Path, ffprobePath });
  const expectedMs = computeExpectedOutputMs({ report });
  const adCheckList = [];
  for (const ad of report.adList) {
    adCheckList.push(await checkAdPlacement({ ad, timeline: report.timeline ?? [], outDir, mp3Path, ffmpegPath, correlationThreshold }));
  }
  const diffMs = Math.round(mp3Ms - expectedMs);
  return {
    isOk: Math.abs(diffMs) <= DURATION_TOLERANCE_MS && adCheckList.every((check) => check.isOk),
    duration: { mp3Ms: Math.round(mp3Ms), expectedMs: Math.round(expectedMs), diffMs },
    adCheckList,
  };
}
