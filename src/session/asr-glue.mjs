import {
  DEBUG_STAGE_MAP, DEBUG_VERDICT_MAP, FEATURE_KEY_MAP, classifyUtteranceEnding, buildSegmentBoundaryList, resolveSpeechEndWallTs,
} from '../product/core-modules.mjs';

// main.js 의 AsrSegmenter onSegment(891-902)·collectGapCandidateList(1094-1107)·handleAsrTranscript(1109-1145).
export function createAsrGlue({ ctx, segmentList, segmentBufferMap }) {
  const { clock, bridge, state, core, featureToggleStore } = ctx;
  const voicedList = segmentList.filter((segment) => segment.isVoiced);
  let nextIndex = 0;

  // 조각은 녹음이 끝난 영상 시각에 보낸다. 시작·끝은 제품처럼 벽시계(Date.now) 값이다.
  // 화자는 화자 식별 기능이 켜졌을 때만 판별한다(main.js:873-889). 공장에는 Meet 화자 표시가 없어 힌트는 늘 null 이고,
  // 판별 여부(isSpeakerTracked)는 제품처럼 기능 토글에서 읽는다 — 평가 프리셋은 꺼져 있어 회의 스크립트에 화자를 적지 않는다.
  function sendSegment(segment) {
    const buffer = segmentBufferMap.get(segment.startMs);
    if (!buffer) {
      ctx.log.warn(`[factory] ASR 조각 ${segment.startMs}ms 인코딩 결과가 없어 건너뛴다`);
      return;
    }
    ctx.trackTask(bridge.invoke('pipeline-audio', {
      startTs: ctx.toWallTs(segment.startMs), endTs: ctx.toWallTs(segment.endMs), buffer: new Uint8Array(buffer), speakerHint: null,
      isSpeakerTracked: featureToggleStore.isOn(FEATURE_KEY_MAP.speakerIdentity),
    }), 'pipeline-audio');
  }

  // 타이머를 한꺼번에 걸지 않고 다음 조각 하나만 건다(긴 영상의 타이머 수를 줄인다).
  function scheduleNext() {
    if (nextIndex >= voicedList.length) return;
    const segment = voicedList[nextIndex];
    clock.setTimeout(() => {
      nextIndex += 1;
      sendSegment(segment);
      scheduleNext();
    }, Math.max(0, segment.endMs - ctx.videoTimeMs()));
  }

  function collectGapCandidateList({ segmentList: asrSegmentList, chunkStartTs, chunkEndTs }) {
    const chunkDurationMs = Math.max(0, chunkEndTs - chunkStartTs);
    const boundaryList = buildSegmentBoundaryList({ segmentList: asrSegmentList, chunkDurationMs });
    const nowVideoTimeMs = ctx.videoTimeMs();
    const nowTs = clock.nowWall();
    for (const boundary of boundaryList) {
      const boundaryTs = chunkStartTs + boundary.offsetMs;
      core.gapCandidateStore.add({
        videoTimeMs: nowVideoTimeMs - (nowTs - boundaryTs), kind: boundary.kind, silenceMs: boundary.silenceMs, text: boundary.text,
      });
    }
    return boundaryList.length;
  }

  // 지시 트리거 후보는 main 이 전사 직후 형태소 분석(Kiwi)·영어 규칙으로 뽑아 asr 이벤트에 실어 보낸다(triggerCandidateList).
  function handleAsrTranscript({ text, ts, endTs, segmentList: asrSegmentList = [], triggerCandidateList = [] }) {
    const trimmed = (text || '').trim();
    if (trimmed) {
      ctx.markDebug({ stage: DEBUG_STAGE_MAP.asr, verdict: DEBUG_VERDICT_MAP.pass, reason: '전사 도착', detail: `"${trimmed}"` });
      // 전사 창 시각은 도착 시각(performance.now)이다.
      core.transcriptWindow.push({ text: trimmed, ts: clock.nowPerf() });
      // 대기 중인 지시 후보가 있으면 이 조각을 뒤 조각으로 먼저 붙인다. 이 조각으로 판정이 났으면 새 후보의 트리거로 쓰지 않는다.
      const { isDecided } = core.candidateScheduler.appendTranscript({ text: trimmed, endTs });
      if (!isDecided) {
        core.deixisDetector.handleTranscript({
          text: trimmed, candidateList: triggerCandidateList, captureTs: endTs,
          resolveEventWallTs: ({ trigger }) => resolveSpeechEndWallTs({ chunkStartTs: ts, chunkEndTs: endTs, segmentList: asrSegmentList, trigger }),
        });
      }
    }
    const candidateCount = collectGapCandidateList({ segmentList: asrSegmentList, chunkStartTs: ts, chunkEndTs: endTs });
    const ending = classifyUtteranceEnding(text);
    if (!ending) return;
    const silenceMsAfter = state.lastAudioActiveAt ? Math.max(0, Math.round(clock.nowPerf() - state.lastAudioActiveAt)) : 0;
    const boundary = core.boundaryDetector.handleTranscript({ text, captureEndTs: endTs, silenceMsAfter });
    bridge.send('pipeline-boundary', {
      captureTs: endTs, text, ending, silenceMsAfter, emitted: Boolean(boundary), kind: boundary?.kind || null,
      segmentCount: asrSegmentList.length, candidateCount,
    });
  }

  return { start: scheduleNext, sendSegment, handleAsrTranscript, collectGapCandidateList };
}
