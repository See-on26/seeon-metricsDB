// src/runner/result-health.mjs
import { SERVICE_MAP } from '../clock/scoped-fetch.mjs';

// 결과를 완료로 치지 않는 사유. 실패로 끝나 재실행이 그 영상을 다시 처리한다.
// 화면 입력 실패, 서비스 장애(ASR 실패 비율 과다·Bedrock 인증 실패), 제품 세션 종료 실패처럼 다시 돌리면 고쳐질 기반 문제만 넣는다.
export const INCOMPLETE_REASON_MAP = {
  frameSourceError: 'frame_source_error', frameCaptureFailed: 'frame_capture_failed',
  asrFailure: 'asr_failure', bedrockAuthFailed: 'bedrock_auth_failed', sessionEndFailed: 'session_end_failed',
};
// ASR 은 지시·무발화·틈 후보 등 모든 감지의 입력이라 실패한 조각만큼 발화가 통째로 사라진다. 10% 를 넘으면 해설 집합이
// 제품과 크게 달라지므로 불완전으로 본다. 그 아래는 일시적 실패로 보고 경고로만 남긴다(동시 3 실측에서도 ASR 실패는 없었고
// p95 6초로 20초 상한과 거리가 멀어, 부하만으로 이 선을 넘어 재처리가 끝없이 반복되지는 않는다). 서비스가 죽으면 100% 가 된다.
export const ASR_FAILURE_RATIO_LIMIT = 0.1;
// 단기 토큰 만료·권한 없음. 한 번 나면 그 뒤 Bedrock 호출(틈 추론·판정 대체·VLM 폴백)이 모두 실패한다.
const BEDROCK_AUTH_STATUS_LIST = [401, 403];
const JUDGE_BACKEND_GPU = 'gpu';
const SERVICE_ORDER_LIST = [SERVICE_MAP.asr, SERVICE_MAP.vlm, SERVICE_MAP.judge, SERVICE_MAP.tts, SERVICE_MAP.embed, SERVICE_MAP.bedrock, SERVICE_MAP.other];
const SERVICE_LABEL_MAP = {
  [SERVICE_MAP.asr]: 'ASR', [SERVICE_MAP.vlm]: 'VLM', [SERVICE_MAP.judge]: '탐지 판정 GPU', [SERVICE_MAP.tts]: 'TTS',
  [SERVICE_MAP.embed]: '임베딩', [SERVICE_MAP.bedrock]: 'Bedrock', [SERVICE_MAP.other]: '기타 서비스',
};
export const WARNING_CODE_MAP = {
  judgeFallback: 'judge_fallback', judgeError: 'judge_error', vlmFallback: 'vlm_fallback', drainTimeout: 'drain_timeout', swallowedError: 'swallowed_error',
};

const isFailedCall = (record) => Boolean(record.errorMessage) || (Number.isFinite(record.status) && record.status >= 400);
const isTimeoutCall = (record) => record.errorName === 'TimeoutError';
const isBedrockAuthCall = (record) => record.service === SERVICE_MAP.bedrock && BEDROCK_AUTH_STATUS_LIST.includes(record.status);
const describeCallError = (record) => record.errorMessage || `HTTP ${record.status}`;
const toPercent = (ratio) => Math.round(ratio * 100);

export function buildIncompleteReasonList({ sessionResult, callLog }) {
  const reasonList = [];
  const { frameSourceError, frameStats, endResult } = sessionResult;
  // 공장 쪽 화면 입력이 실패하면 제품이 했을 판정(슬라이드·포인팅·지시 화면)이 빠져 실험실과 견줄 수 없다.
  if (frameSourceError) {
    reasonList.push({ code: INCOMPLETE_REASON_MAP.frameSourceError, message: frameSourceError.message, videoTimeMs: frameSourceError.videoTimeMs });
  }
  if (frameStats?.captureFailCount > 0) reasonList.push({ code: INCOMPLETE_REASON_MAP.frameCaptureFailed, count: frameStats.captureFailCount });
  const asrCallList = callLog.filter((record) => record.service === SERVICE_MAP.asr);
  const failedAsrList = asrCallList.filter(isFailedCall);
  if (asrCallList.length && failedAsrList.length / asrCallList.length > ASR_FAILURE_RATIO_LIMIT) {
    reasonList.push({ code: INCOMPLETE_REASON_MAP.asrFailure, count: failedAsrList.length, total: asrCallList.length, message: describeCallError(failedAsrList[0]) });
  }
  const authFailedList = callLog.filter(isBedrockAuthCall);
  if (authFailedList.length) {
    reasonList.push({ code: INCOMPLETE_REASON_MAP.bedrockAuthFailed, count: authFailedList.length, message: describeCallError(authFailedList[0]) });
  }
  // 세션을 닫지 못하면 제품 기록 파일(pipeline-*.jsonl)의 끝이 확정되지 않는다.
  if (endResult?.isOk === false) reasonList.push({ code: INCOMPLETE_REASON_MAP.sessionEndFailed, message: endResult.message ?? null });
  return reasonList;
}

export function describeIncompleteReason(reason) {
  switch (reason.code) {
    case INCOMPLETE_REASON_MAP.frameSourceError: return `프레임 읽기 실패(${Math.round(reason.videoTimeMs)}ms): ${reason.message}`;
    case INCOMPLETE_REASON_MAP.frameCaptureFailed: return `JPEG 캡처 실패 ${reason.count}건`;
    case INCOMPLETE_REASON_MAP.asrFailure:
      return `ASR 실패 ${reason.count}/${reason.total}건(${toPercent(reason.count / reason.total)}% > ${toPercent(ASR_FAILURE_RATIO_LIMIT)}%) — ${reason.message}`;
    case INCOMPLETE_REASON_MAP.bedrockAuthFailed: return `Bedrock 인증 실패 ${reason.count}건(${reason.message}) — AWS_BEARER_TOKEN_BEDROCK 만료·권한을 확인한다`;
    case INCOMPLETE_REASON_MAP.sessionEndFailed: return `제품 세션 종료 실패 — ${reason.message}`;
    default: return reason.code;
  }
}

const sumCountMap = (countMap) => Object.values(countMap || {}).reduce((sum, count) => sum + count, 0);
const describeCountMap = (countMap) => Object.entries(countMap).map(([key, count]) => `${key} ${count}`).join(' · ');

// 판정기마다 한 갈래(gpu·bedrock·error)의 수만 골라 0 이 아닌 것만 남긴다.
function pickJudgeSourceCountMap({ judgeSourceCountMap, source }) {
  return Object.fromEntries(Object.entries(judgeSourceCountMap || {})
    .map(([judgeKey, countMap]) => [judgeKey, countMap?.[source] || 0]).filter(([, count]) => count > 0));
}

// 서비스별 시간 초과·실패. 불완전 사유로 이미 센 것(ASR 실패 과다, Bedrock 인증 실패)은 겹쳐 세지 않는다.
function buildServiceWarningList({ callLog, incompleteReasonList }) {
  const isAsrIncomplete = incompleteReasonList.some((reason) => reason.code === INCOMPLETE_REASON_MAP.asrFailure);
  const warningList = [];
  for (const service of SERVICE_ORDER_LIST) {
    if (service === SERVICE_MAP.asr && isAsrIncomplete) continue;
    const callList = callLog.filter((record) => record.service === service);
    const failedList = callList.filter((record) => isFailedCall(record) && !isBedrockAuthCall(record));
    const timeoutList = failedList.filter(isTimeoutCall);
    const errorList = failedList.filter((record) => !isTimeoutCall(record));
    const label = SERVICE_LABEL_MAP[service];
    if (timeoutList.length) warningList.push({ code: `${service}_timeout`, count: timeoutList.length, message: `${label} 호출 시간 초과 ${timeoutList.length}/${callList.length}건` });
    if (errorList.length) {
      warningList.push({ code: `${service}_error`, count: errorList.length, message: `${label} 호출 실패 ${errorList.length}/${callList.length}건 — ${describeCallError(errorList[0])}` });
    }
  }
  return warningList;
}

// 결과를 실패로 만들지 않는 품질 저하. 동시 처리로 GPU 가 포화되면 정상적으로도 생기므로(실측: 동시 3 에서 VLM 시간 초과 4/16)
// 불완전으로 치면 재실행이 끝없이 같은 영상을 다시 돈다. 대신 JSON warningList 와 터미널·summary 의 ⚠ 로 드러낸다.
export function buildWarningList({ callLog, judgeSourceCountMap, judgeBackend, sessionResult, swallowedErrorCountMap, incompleteReasonList }) {
  const warningList = buildServiceWarningList({ callLog, incompleteReasonList });
  // gpu 판정 백엔드에서 Bedrock 이 답했다면 GPU 판정이 실패해 넘어간 것이다.
  const fallbackCountMap = judgeBackend === JUDGE_BACKEND_GPU ? pickJudgeSourceCountMap({ judgeSourceCountMap, source: 'bedrock' }) : {};
  if (sumCountMap(fallbackCountMap)) {
    warningList.push({
      code: WARNING_CODE_MAP.judgeFallback, count: sumCountMap(fallbackCountMap),
      message: `탐지 판정을 GPU 대신 Bedrock 이 판정 ${sumCountMap(fallbackCountMap)}건(${describeCountMap(fallbackCountMap)})`,
    });
  }
  const judgeErrorCountMap = pickJudgeSourceCountMap({ judgeSourceCountMap, source: 'error' });
  if (sumCountMap(judgeErrorCountMap)) {
    warningList.push({
      code: WARNING_CODE_MAP.judgeError, count: sumCountMap(judgeErrorCountMap),
      message: `탐지 판정 실패(LLM 없이 통과·차단) ${sumCountMap(judgeErrorCountMap)}건(${describeCountMap(judgeErrorCountMap)})`,
    });
  }
  const vlmFallbackCount = callLog.filter((record) => record.isVlmFallback).length;
  if (vlmFallbackCount) warningList.push({ code: WARNING_CODE_MAP.vlmFallback, count: vlmFallbackCount, message: `VLM 대신 Bedrock 폴백 ${vlmFallbackCount}건` });
  if (sessionResult.isDrainTimedOut) {
    warningList.push({
      code: WARNING_CODE_MAP.drainTimeout, count: 1,
      message: `배수 상한(영상 끝 + ${Math.round(sessionResult.drainLimitMs / 1000)}초)에 닿아 멈춤 — 남은 작업 ${sessionResult.remainingTaskCount} · 진행 중 호출 ${sessionResult.inFlightCallCount}`,
    });
  }
  const swallowedCountMap = {
    ...swallowedErrorCountMap?.task,
    ...Object.fromEntries(Object.entries(swallowedErrorCountMap?.ipc || {}).map(([channel, count]) => [`ipc:${channel}`, count])),
  };
  if (sumCountMap(swallowedCountMap)) {
    warningList.push({
      code: WARNING_CODE_MAP.swallowedError, count: sumCountMap(swallowedCountMap),
      message: `연결 코드가 삼킨 오류 ${sumCountMap(swallowedCountMap)}건(${describeCountMap(swallowedCountMap)})`,
    });
  }
  return warningList;
}

// 터미널·summary 한 줄에 붙이는 짧은 표시. 경고가 없으면 빈 문자열.
export function formatWarningBrief(warningList = []) {
  if (!warningList?.length) return '';
  return `⚠ ${warningList.map((warning) => `${warning.code} ${warning.count}`).join(' · ')}`;
}
