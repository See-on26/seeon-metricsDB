import fs from 'node:fs';
import { PIECE_KIND_MAP, summarizeTimeline } from '../session/playback-recorder.mjs';
import { computeServiceStats } from '../clock/scoped-fetch.mjs';
import { redactUrlCredential } from '../util/redact-url-credential.mjs';

// 필드 이름은 실험실 ad-timeline.json(src/main/lab/export/ad-timeline.js)과 맞춘다. 비교 도구가 두 기록을 같은 이름으로 읽는다.
export const AID_MAP = { page_transition: 'A1', deixis: 'A2', interpretation: 'A3', visual_description: 'A4', user_command: 'Q', speaker_identity: 'S' };
const LEGACY_TRANSITION_SOURCE = 'page-transition';
const NOT_PLAYED_REASON = 'not_played';
const SUPPRESSED_REASON = 'suppressed';
const PIPELINE_RECORD_KIND_MAP = { narration: 'narration', deixis: 'deixis', debug: 'debug' };
const roundOrNull = (value) => (Number.isFinite(value) ? Math.round(value) : null);
const normalizeType = (source) => (source === LEGACY_TRANSITION_SOURCE ? 'page_transition' : source || null);
const buildCaptionKey = ({ ts, text }) => `${ts}|${text}`;

// 기록에 남기는 모델·서비스 설정 이름. 제품 설정(readPipelineConfig)에서 비밀이 아닌 것만 고른 허용 목록이라, 제품이 키·토큰 같은
// 새 필드를 더해도 여기에 넣기 전에는 기록에 실리지 않는다(Bedrock 토큰 bedrockApiKey 는 넣지 않는다).
export const REPORT_MODEL_CONFIG_KEY_LIST = [
  'vlmUrl', 'vlmModel', 'asrUrl', 'asrLanguage', 'questionAsrLanguage', 'ttsUrl', 'ttsLongUrl', 'embedUrl',
  'slideTextBackend', 'isScreenTextGroundingEnabled', 'ocrUrl', 'gapSource', 'bedrockRegion', 'bedrockModelId', 'judgeModelId', 'judgeBackend',
  'judgeGpuUrl', 'judgeGpuModel', 'summaryModelId', 'summaryRewriteModelId', 'routerMode', 'isScaleEnabled', 'hasBedrockCredentials',
];

// 제품 모델 설정에서 허용 목록의 이름만 골라 기록용으로 만든다. 서비스 주소에 넣은 사용자 정보(user:pass@)는 지운다.
export function buildReportModelConfig({ modelConfig }) {
  return Object.fromEntries(REPORT_MODEL_CONFIG_KEY_LIST
    .filter((key) => Object.hasOwn(modelConfig, key))
    .map((key) => [key, redactUrlCredential(modelConfig[key])]));
}

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

// 슬라이드 전사(새 슬라이드마다 한 번) 기록. 제품 slide-text-store 의 onSettled 가 남기는 디버그 줄(index.js:227-235)에서 읽는다:
// stage value_check, reason '슬라이드 텍스트 전사 <ready|none|failed>',
// detail '슬라이드=<라벨> 글자수=<n> 출처=<ocr|vlm|->[ 넘김=<이유>] 줄=<n> <ms>ms[ · <오류>]'.
// 넘김 이유는 제품 slide-text-agent.js OCR_FALLBACK_REASON_MAP 과 ocr_error:<문구> 다. ocr_error 는 문구를 떼고 센다.
const SLIDE_TEXT_STAGE = 'value_check';
const SLIDE_TEXT_REASON_PATTERN = /^슬라이드 텍스트 전사 (\S+)$/;
const SLIDE_TEXT_DETAIL_PATTERN = / 출처=(\S+)(?: 넘김=(.*?))? 줄=\d+ -?\d+ms/;
export const SLIDE_TEXT_SOURCE_LIST = ['ocr', 'vlm'];
export const SLIDE_TEXT_FALLBACK_REASON_LIST = ['low_score', 'vertical_text', 'ocr_error', 'ocr_bypass'];
const OCR_ERROR_REASON = 'ocr_error';
const toZeroCountMap = (keyList) => Object.fromEntries(keyList.map((key) => [key, 0]));

// count: 전사가 끝난 슬라이드 수, statusCountMap: 결과(ready 글자 있음·none 글자 없음·failed 실패),
// sourceCountMap: 실제로 전사한 엔진(OCR 이 실패·저신뢰·세로 글씨라 VLM 으로 넘긴 장은 vlm), fallbackReasonCountMap: VLM 으로 넘긴 이유.
export function summarizeSlideTextRecordList({ pipelineRecordList }) {
  const summary = {
    count: 0, statusCountMap: {}, sourceCountMap: toZeroCountMap(SLIDE_TEXT_SOURCE_LIST),
    fallbackReasonCountMap: toZeroCountMap(SLIDE_TEXT_FALLBACK_REASON_LIST),
  };
  for (const record of pipelineRecordList) {
    if (record.kind !== PIPELINE_RECORD_KIND_MAP.debug || record.stage !== SLIDE_TEXT_STAGE) continue;
    const status = SLIDE_TEXT_REASON_PATTERN.exec(record.reason || '')?.[1];
    if (!status) continue;
    summary.count += 1;
    summary.statusCountMap[status] = (summary.statusCountMap[status] || 0) + 1;
    const [, source, fallbackReason] = SLIDE_TEXT_DETAIL_PATTERN.exec(record.detail || '') || [];
    if (source && source !== '-') summary.sourceCountMap[source] = (summary.sourceCountMap[source] || 0) + 1;
    if (fallbackReason) {
      const reasonKey = fallbackReason.startsWith(`${OCR_ERROR_REASON}:`) ? OCR_ERROR_REASON : fallbackReason;
      summary.fallbackReasonCountMap[reasonKey] = (summary.fallbackReasonCountMap[reasonKey] || 0) + 1;
    }
  }
  return summary;
}

// 해설 소리 합성(pipeline-tts) 수. 렌더러는 재생 차례가 가까운 해설만 합성하므로 요청 수는 해설 수보다 적을 수 있다.
// requestCount = okCount + failCount + pendingAtStopCount. pendingAtStopCount: 세션을 멈출 때 응답이 없었거나 정지 정리 중 시작된 합성
// (성공·실패에 넣지 않는다). onDemandCount: 재생 차례가 온 뒤에야 합성한 수(그동안 지연 재생이 멈춰 무음),
// unplayedOkCount: 합성했지만 재생 전에 버린 수.
function summarizeTtsStat({ captionRecordList, playedSeqSet }) {
  const ttsRecordList = captionRecordList.filter((record) => record.tts);
  const pendingRecordList = ttsRecordList.filter((record) => record.tts.isPendingAtStop);
  const okRecordList = ttsRecordList.filter((record) => record.tts.isOk && !record.tts.isPendingAtStop);
  return {
    requestCount: ttsRecordList.length, okCount: okRecordList.length,
    failCount: ttsRecordList.length - okRecordList.length - pendingRecordList.length, pendingAtStopCount: pendingRecordList.length,
    onDemandCount: ttsRecordList.filter((record) => record.tts.isOnDemand).length,
    unplayedOkCount: okRecordList.filter((record) => !playedSeqSet.has(record.captionSeq)).length,
  };
}

export function buildAdReport({
  video, seeonMeet, config, sessionStartWallMs, pieceList, captionRecordList, adPlayList, dropRecordList, pipelineRecordList,
  callLog, judgeSourceCountMap = null, triggerAnalyzerCountMap = null, adFileByRef, outputFileName, renderedDurationMs, processingMs,
}) {
  const recordBySeq = new Map(captionRecordList.map((record) => [record.captionSeq, record]));
  const playedSeqSet = new Set(adPlayList.map((adPlay) => adPlay.captionSeq));
  // 재생된 뒤 끊긴 해설(질문 답이 끊음)은 실험실처럼 버린 목록이 아니라 AD 항목의 interruptedReason 으로 남긴다.
  const interruptedReasonBySeq = new Map(dropRecordList.filter((drop) => playedSeqSet.has(drop.captionSeq)).map((drop) => [drop.captionSeq, drop.reason]));
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
    const serviceCallList = [...(record.callList || []), ...(record.gap?.callList || []), ...(record.tts?.callList || [])]
      .map(({ service, modelId, status, elapsedMs }) => ({ service, modelId, status, elapsedMs }));
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
      interruptedReason: interruptedReasonBySeq.get(adPlay.captionSeq) ?? null,
      gap: record.gap ? { source: record.gap.source, reason: record.gap.reason, gapIndex: record.gap.gapIndex, candidateCount: record.gap.candidateCount } : null,
      // isPrefetched: 재생 차례 전에 미리 합성했는지, synthMs: 합성에 걸린 시간, waitMs: 차례가 온 뒤 소리를 기다린 시간(그만큼 무음).
      tts: record.tts ? { isPrefetched: !record.tts.isOnDemand, synthMs: roundOrNull(record.tts.elapsedMs), waitMs: roundOrNull(record.ttsWaitMs) } : null,
      serviceCallList, wavFile: adFileByRef.get(adPlay.captionSeq) ?? null,
    };
  });

  // 버린 해설: 렌더러가 사유를 남긴 것, 사유 없이 끝내 재생되지 않은 것, main 이 발행하지 않은 것(간격·중복·기능 꺼짐).
  // reason 은 제품 사유이고, factoryReason 은 세션을 멈춰 버린 해설(stopped)을 공장이 영상 끝 기준으로 나눈 것(after_end·drain_timeout)이다.
  const droppedSeqSet = new Set(dropRecordList.map((drop) => drop.captionSeq));
  const toDrop = (record, reason, factoryReason = null) => ({
    text: record.text, type: normalizeType(record.source), narrationClass: record.narrationClass ?? null,
    slideLabel: record.slideLabel ?? null, eventMediaMs: toEventMediaMs(record), reason, factoryReason,
  });
  const droppedList = [
    ...dropRecordList.filter((drop) => !playedSeqSet.has(drop.captionSeq)).map((drop) => toDrop(drop, drop.reason, drop.factoryReason ?? null)),
    ...captionRecordList.filter((record) => !playedSeqSet.has(record.captionSeq) && !droppedSeqSet.has(record.captionSeq)).map((record) => toDrop(record, NOT_PLAYED_REASON)),
    ...pipelineRecordList.filter((record) => record.kind === PIPELINE_RECORD_KIND_MAP.narration && record.isEmitted === false).map((record) => ({
      text: record.text, type: normalizeType(record.source), narrationClass: record.narrationClass || null,
      slideLabel: record.slideLabel ?? null, eventMediaMs: toMediaMs(record.ts), reason: record.skipReason || SUPPRESSED_REASON, factoryReason: null,
    })),
  ].sort((left, right) => (left.eventMediaMs ?? 0) - (right.eventMediaMs ?? 0));

  const summary = summarizeTimeline(pieceList);
  const { serviceMap, bedrockModelMap } = computeServiceStats({ callLog });
  const reportConfig = config?.modelConfig ? { ...config, modelConfig: buildReportModelConfig({ modelConfig: config.modelConfig }) } : config;
  return {
    schemaVersion: 1, isComplete: true, video, seeonMeet, config: reportConfig,
    output: {
      file: outputFileName, renderedDurationMs: roundOrNull(renderedDurationMs), timelineDurationMs: roundOrNull(summary.outputDurationMs),
      sourceMediaMs: roundOrNull(summary.sourceMediaMs), adTotalMs: roundOrNull(summary.adTotalMs),
      silenceTotalMs: roundOrNull(summary.silenceTotalMs), recoveredMs: roundOrNull(summary.recoveredMs),
    },
    adList, droppedList,
    timeline: pieceList.map((piece) => ({ ...piece, outStartMs: Math.round(piece.outStartMs), outEndMs: Math.round(piece.outEndMs) })),
    // judgeSourceCountMap: 탐지 판정기(router·silence·deixis)마다 답한 곳(gpu·bedrock)·실패(error) 수. GPU 판정 호출의 지연은 serviceMap.judge 에 있다.
    // triggerAnalyzerCountMap: main 트리거가 전사마다 쓴 분석기(kiwi·english, 한국어를 Kiwi 없이 뽑으면 rule) 수.
    // slideText: 슬라이드 전사 출처(ocr·vlm)와 VLM 으로 넘긴 이유 수(summarizeSlideTextRecordList).
    stats: {
      serviceMap, bedrockModelMap, judgeSourceCountMap, triggerAnalyzerCountMap, slideText: summarizeSlideTextRecordList({ pipelineRecordList }),
      tts: summarizeTtsStat({ captionRecordList, playedSeqSet }), processingMs: Math.round(processingMs),
      realtimeFactor: processingMs > 0 ? Math.round((video.durationMs / processingMs) * 100) / 100 : null,
    },
  };
}
