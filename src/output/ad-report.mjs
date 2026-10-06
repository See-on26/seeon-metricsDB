import fs from 'node:fs';
import { PIECE_KIND_MAP, summarizeTimeline } from '../session/playback-recorder.mjs';
import { computeServiceStats } from '../clock/scoped-fetch.mjs';

// 필드 이름은 실험실 ad-timeline.json(src/main/lab/export/ad-timeline.js)과 맞춘다. 비교 도구가 두 기록을 같은 이름으로 읽는다.
export const AID_MAP = { page_transition: 'A1', deixis: 'A2', interpretation: 'A3', visual_description: 'A4', user_command: 'Q', speaker_identity: 'S' };
const LEGACY_TRANSITION_SOURCE = 'page-transition';
const NOT_PLAYED_REASON = 'not_played';
const SUPPRESSED_REASON = 'suppressed';
const PIPELINE_RECORD_KIND_MAP = { narration: 'narration', deixis: 'deixis' };
const roundOrNull = (value) => (Number.isFinite(value) ? Math.round(value) : null);
const normalizeType = (source) => (source === LEGACY_TRANSITION_SOURCE ? 'page_transition' : source || null);
const buildCaptionKey = ({ ts, text }) => `${ts}|${text}`;

function parseAnchorText(summary) {
  const text = /근거 표현=([^·]*)/.exec(summary || '')?.[1]?.trim() || '';
  return text === '(없음)' ? '' : text;
}

// 제품 기록 파일(JSONL)을 읽는다. 쓰다 끊긴 마지막 줄처럼 깨진 줄은 건너뛴다.
export function readPipelineRecordList({ recordPath }) {
  if (!recordPath || !fs.existsSync(recordPath)) return [];
  return fs.readFileSync(recordPath, 'utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

export function buildAdReport({
  video, seeonMeet, config, sessionStartWallMs, pieceList, captionRecordList, adPlayList, dropRecordList, pipelineRecordList,
  callLog, adFileByRef, outputFileName, renderedDurationMs, processingMs,
}) {
  const recordBySeq = new Map(captionRecordList.map((record) => [record.captionSeq, record]));
  const adPieceByRef = new Map(pieceList.filter((piece) => piece.kind === PIECE_KIND_MAP.ad).map((piece) => [piece.adRef, piece]));
  const deixisByKey = new Map(pipelineRecordList
    .filter((record) => record.kind === PIPELINE_RECORD_KIND_MAP.deixis && record.caption)
    .map((record) => [buildCaptionKey({ ts: record.ts, text: record.caption }), record]));
  // 영상 시각 0 의 벽시계가 세션 시작이라 벽시계 ts 를 바로 영상 시각으로 바꾼다.
  const toMediaMs = (wallTs) => roundOrNull(wallTs - sessionStartWallMs);
  // 실험실처럼 사건 영상 시각이 없는 캡션은 만든 시각(ts)으로 잰다.
  const toEventMediaMs = (record) => (Number.isFinite(record.eventVideoTimeMs) ? roundOrNull(record.eventVideoTimeMs) : toMediaMs(record.ts));

  const adList = adPlayList.map((adPlay, index) => {
    const record = recordBySeq.get(adPlay.captionSeq) || {};
    const type = normalizeType(record.source);
    const deixis = deixisByKey.get(buildCaptionKey(record)) || null;
    const serviceCallList = [...(record.callList || []), ...(record.gap?.callList || [])]
      .map(({ service, modelId, isVlmFallback, status, elapsedMs }) => ({ service, modelId, isVlmFallback, status, elapsedMs }));
    const eventMediaMs = toEventMediaMs(record);
    const playedMediaMs = roundOrNull(adPlay.playedMediaMs);
    return {
      id: `ad-${String(index + 1).padStart(3, '0')}`, captionSeq: adPlay.captionSeq,
      narrationClass: record.narrationClass ?? null, type, aid: AID_MAP[type] || null, text: record.text ?? '',
      eventMediaMs, insertMediaMs: roundOrNull(record.insertVideoTimeMs),
      playedMediaMs, outputMs: roundOrNull(adPieceByRef.get(adPlay.captionSeq)?.outStartMs),
      durationMs: roundOrNull(adPlay.durationMs), slideLabel: record.slideLabel ?? null, rationale: record.rationale ?? null,
      trigger: {
        utterance: record.rationale?.utterance || deixis?.utterance || null,
        anchor: parseAnchorText(record.rationale?.summary) || null,
        judgeReason: deixis?.judgeReason ?? null,
      },
      latencyMs: Number.isFinite(playedMediaMs) && Number.isFinite(eventMediaMs) ? playedMediaMs - eventMediaMs : null,
      gap: record.gap ? { source: record.gap.source, reason: record.gap.reason, gapIndex: record.gap.gapIndex, candidateCount: record.gap.candidateCount } : null,
      serviceCallList, isVlmFallback: serviceCallList.some((call) => call.isVlmFallback),
      wavFile: adFileByRef.get(adPlay.captionSeq) ?? null,
    };
  });

  // 버린 해설: 렌더러가 사유를 남긴 것, 사유 없이 끝내 재생되지 않은 것, main 이 발행하지 않은 것(간격·중복·기능 꺼짐).
  const playedSeqSet = new Set(adPlayList.map((adPlay) => adPlay.captionSeq));
  const droppedSeqSet = new Set(dropRecordList.map((drop) => drop.captionSeq));
  const toDrop = (record, reason) => ({
    text: record.text, type: normalizeType(record.source), narrationClass: record.narrationClass ?? null,
    slideLabel: record.slideLabel ?? null, eventMediaMs: toEventMediaMs(record), reason,
  });
  const droppedList = [
    ...dropRecordList.map((drop) => toDrop(drop, drop.reason)),
    ...captionRecordList.filter((record) => !playedSeqSet.has(record.captionSeq) && !droppedSeqSet.has(record.captionSeq)).map((record) => toDrop(record, NOT_PLAYED_REASON)),
    ...pipelineRecordList.filter((record) => record.kind === PIPELINE_RECORD_KIND_MAP.narration && record.isEmitted === false).map((record) => ({
      text: record.text, type: normalizeType(record.source), narrationClass: record.narrationClass || null,
      slideLabel: record.slideLabel ?? null, eventMediaMs: toMediaMs(record.ts), reason: record.skipReason || SUPPRESSED_REASON,
    })),
  ].sort((left, right) => (left.eventMediaMs ?? 0) - (right.eventMediaMs ?? 0));

  const summary = summarizeTimeline(pieceList);
  const { serviceMap, bedrockModelMap } = computeServiceStats({ callLog });
  return {
    schemaVersion: 1, isComplete: true, video, seeonMeet, config,
    output: {
      file: outputFileName, renderedDurationMs: roundOrNull(renderedDurationMs), timelineDurationMs: roundOrNull(summary.outputDurationMs),
      sourceMediaMs: roundOrNull(summary.sourceMediaMs), adTotalMs: roundOrNull(summary.adTotalMs),
      silenceTotalMs: roundOrNull(summary.silenceTotalMs), recoveredMs: roundOrNull(summary.recoveredMs),
    },
    adList, droppedList,
    timeline: pieceList.map((piece) => ({ ...piece, outStartMs: Math.round(piece.outStartMs), outEndMs: Math.round(piece.outEndMs) })),
    stats: {
      serviceMap, bedrockModelMap, processingMs: Math.round(processingMs),
      realtimeFactor: processingMs > 0 ? Math.round((video.durationMs / processingMs) * 100) / 100 : null,
    },
  };
}
