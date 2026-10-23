import {
  isSegmentVoiced, shouldCutSegment, DEFAULT_MAX_EXTEND_MS, DEFAULT_EXTEND_SILENCE_CUT_MS,
} from '../product/core-modules.mjs';
import { readLevelAt } from './audio-levels.mjs';
import { VAD_SAMPLE_MS, ASR_VOICE_LEVEL_THRESHOLD, ASR_MIN_VOICED_MS, ASR_SILENCE_CUT_MS } from '../session/renderer-constants.mjs';

// 행 번호는 seeon-meet origin/production 0a17718 기준이다.
// AsrSegmenter(코어 trigger/asr-segmenter.js:87-141)를 그대로 따른다. 제품은 미터 레벨을 getVoiceLevel 로 넘겨(main.js:977-988)
// 말소리 측정 갈래를 탄다. 공장의 레벨 목록은 같은 미터 레벨(AnalyserNode 바이트 RMS)을 100ms 격자로 미리 잰 것이다.
// 조각 시작부터 100ms 마다 레벨을 보고, 무음 tick 마다 shouldCutSegment 로 자를지 정한다: 2.5초가 지난 뒤 끝 무음 400ms 면 자르고,
// 조각 길이(segmentMs)가 찼을 때 말하는 중이면 낱말 사이 쉼 200ms 까지 기다린다. 쉼이 없으면 조각 길이 + 1.5초 타이머에 자른다.
// 말이 200ms 미만인 조각은 보내지 않는다. 레벨만으로 정해지므로 미리 계산한다.
export function planAsrSegmentList({
  levelList, durationMs, segmentMs, minSegmentMs, tickMs = VAD_SAMPLE_MS,
  voiceThreshold = ASR_VOICE_LEVEL_THRESHOLD, minVoicedMs = ASR_MIN_VOICED_MS, silenceCutMs = ASR_SILENCE_CUT_MS,
}) {
  // 조각 길이가 0 이하이면 조각이 앞으로 나가지 않고, 길이가 무한이면 끝나지 않는다. 계획 전에 막는다.
  if (!(Number.isFinite(segmentMs) && segmentMs > 0)) throw new RangeError(`segmentMs 는 0 보다 큰 유한수여야 한다: ${segmentMs}`);
  if (!(Number.isFinite(tickMs) && tickMs > 0)) throw new RangeError(`tickMs 는 0 보다 큰 유한수여야 한다: ${tickMs}`);
  if (!(Number.isFinite(durationMs) && durationMs >= 0)) throw new RangeError(`durationMs 는 0 이상 유한수여야 한다: ${durationMs}`);
  const effectiveMinSegmentMs = Math.min(minSegmentMs, segmentMs);
  const segmentList = [];
  let startMs = 0;
  while (startMs < durationMs) {
    // 말소리 측정이 있으면 타이머는 늘린 상한에서만 자른다(asr-segmenter.js:137-140).
    const limitMs = Math.min(startMs + segmentMs + DEFAULT_MAX_EXTEND_MS, durationMs);
    let voicedMs = 0;
    let silenceMs = 0;
    let endMs = limitMs;
    for (let elapsedMs = tickMs; startMs + elapsedMs <= limitMs; elapsedMs += tickMs) {
      const level = readLevelAt({ levelList, timeMs: startMs + elapsedMs, tickMs });
      if (level >= voiceThreshold) {
        voicedMs += tickMs;
        silenceMs = 0;
        continue;
      }
      silenceMs += tickMs;
      const isCutReady = shouldCutSegment({
        elapsedMs, silenceMs, voicedMs, segmentMs, minSegmentMs: effectiveMinSegmentMs, silenceCutMs, minVoicedMs,
        maxExtendMs: DEFAULT_MAX_EXTEND_MS, extendSilenceCutMs: DEFAULT_EXTEND_SILENCE_CUT_MS,
      });
      if (isCutReady) {
        endMs = startMs + elapsedMs;
        break;
      }
    }
    segmentList.push({ startMs, endMs, voicedMs, isVoiced: isSegmentVoiced({ voicedMs, minVoicedMs }) });
    startMs = endMs;
  }
  return segmentList;
}
