import { isSegmentVoiced, isSegmentCutReady } from '../product/core-modules.mjs';
import { readLevelAt } from './audio-levels.mjs';
import { VAD_SAMPLE_MS, ASR_VOICE_LEVEL_THRESHOLD, ASR_MIN_VOICED_MS, ASR_SILENCE_CUT_MS } from '../session/renderer-constants.mjs';

// AsrSegmenter 를 그대로 따른다: 조각 시작부터 100ms 마다 레벨을 보고, 2.5초가 지난 뒤 끝 무음이 400ms 쌓이면 자르고,
// 아니면 segmentMs 에 자른다. 말이 200ms 미만인 조각은 보내지 않는다. 레벨만으로 정해지므로 미리 계산한다.
export function planAsrSegmentList({
  levelList, durationMs, segmentMs, minSegmentMs, tickMs = VAD_SAMPLE_MS,
  voiceThreshold = ASR_VOICE_LEVEL_THRESHOLD, minVoicedMs = ASR_MIN_VOICED_MS, silenceCutMs = ASR_SILENCE_CUT_MS,
}) {
  const effectiveMinSegmentMs = Math.min(minSegmentMs, segmentMs);
  const segmentList = [];
  let startMs = 0;
  while (startMs < durationMs) {
    const limitMs = Math.min(startMs + segmentMs, durationMs);
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
      const isCutReady = voicedMs >= minVoicedMs
        && isSegmentCutReady({ elapsedMs, silenceMs, minSegmentMs: effectiveMinSegmentMs, silenceCutMs });
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
