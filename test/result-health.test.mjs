import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIncompleteReasonList, buildWarningList, describeIncompleteReason, formatWarningBrief, ASR_FAILURE_RATIO_LIMIT,
} from '../src/runner/result-health.mjs';

const call = (service, extra = {}) => ({ service, status: 200, errorMessage: null, errorName: null, errorCode: null, isVlmFallback: false, ...extra });
const timeoutCall = (service) => call(service, { status: null, errorMessage: 'The operation was aborted due to timeout', errorName: 'TimeoutError' });
const REFUSED_MESSAGE = 'fetch failed (ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:18802)';
const refusedCall = (service) => call(service, { status: null, errorMessage: REFUSED_MESSAGE, errorName: 'TypeError', errorCode: 'ECONNREFUSED' });
const repeat = (count, makeCall) => Array.from({ length: count }, makeCall);
const OK_SESSION = { frameSourceError: null, frameStats: { captureFailCount: 0 }, endResult: { isOk: true }, isDrainTimedOut: false };
const EMPTY_JUDGE_MAP = { router: { gpu: 0, bedrock: 0, error: 0 }, silence: { gpu: 0, bedrock: 0, error: 0 }, deixis: { gpu: 0, bedrock: 0, error: 0 } };

test('불완전: ASR 실패가 10% 를 넘으면, Bedrock 401·403 이 하나라도 있으면, 제품 세션 종료가 실패하면 결과를 완료로 치지 않는다', () => {
  assert.equal(ASR_FAILURE_RATIO_LIMIT, 0.1);
  const asrLog = (failCount, total) => [...repeat(total - failCount, () => call('asr')), ...repeat(failCount, () => refusedCall('asr'))];
  assert.deepEqual(buildIncompleteReasonList({ sessionResult: OK_SESSION, callLog: asrLog(1, 10) }), [], '10% 는 경고로 남긴다');
  const asrReasonList = buildIncompleteReasonList({ sessionResult: OK_SESSION, callLog: asrLog(2, 10) });
  assert.deepEqual(asrReasonList, [{ code: 'asr_failure', count: 2, total: 10, message: REFUSED_MESSAGE }]);
  assert.equal(describeIncompleteReason(asrReasonList[0]), `ASR 실패 2/10건(20% > 10%) — ${REFUSED_MESSAGE}`);
  assert.deepEqual(buildIncompleteReasonList({ sessionResult: OK_SESSION, callLog: [] }), [], 'ASR 호출이 없는(소리 없는) 영상');

  const authReasonList = buildIncompleteReasonList({
    sessionResult: OK_SESSION,
    callLog: [call('bedrock'), call('bedrock', { status: 403 }), call('bedrock', { status: 401 }), call('bedrock', { status: 429 })],
  });
  assert.deepEqual(authReasonList, [{ code: 'bedrock_auth_failed', count: 2, message: 'HTTP 403' }]);
  assert.match(describeIncompleteReason(authReasonList[0]), /^Bedrock 인증 실패 2건\(HTTP 403\) — AWS_BEARER_TOKEN_BEDROCK 만료·권한을 확인한다$/);

  const endReasonList = buildIncompleteReasonList({ sessionResult: { ...OK_SESSION, endResult: { isOk: false, message: 'pipeline-session-end 가 30000ms 안에 끝나지 않았다' } }, callLog: [] });
  assert.deepEqual(endReasonList, [{ code: 'session_end_failed', message: 'pipeline-session-end 가 30000ms 안에 끝나지 않았다' }]);
  assert.equal(describeIncompleteReason(endReasonList[0]), '제품 세션 종료 실패 — pipeline-session-end 가 30000ms 안에 끝나지 않았다');
  assert.deepEqual(buildIncompleteReasonList({ sessionResult: { ...OK_SESSION, endResult: {} }, callLog: [] }), [], 'isOk 가 false 일 때만 실패다');

  const frameReasonList = buildIncompleteReasonList({
    sessionResult: { ...OK_SESSION, frameSourceError: { message: '디코드 실패', videoTimeMs: 2000 }, frameStats: { captureFailCount: 3 } }, callLog: [],
  });
  assert.deepEqual(frameReasonList.map(describeIncompleteReason), ['프레임 읽기 실패(2000ms): 디코드 실패', 'JPEG 캡처 실패 3건']);
});

test('경고: 부하로 생기는 시간 초과·서비스 오류·판정 Bedrock 대체·VLM 폴백·배수 상한·삼킨 오류는 실패로 만들지 않고 코드별 수로 남긴다', () => {
  const callLog = [
    ...repeat(10, () => call('asr')), timeoutCall('asr'),
    ...repeat(12, () => call('vlm')), ...repeat(4, () => timeoutCall('vlm')),
    ...repeat(5, () => call('judge')), timeoutCall('judge'),
    ...repeat(2, () => call('tts')), call('tts', { status: 500 }),
    ...repeat(3, () => call('bedrock')), call('bedrock', { status: 429, errorMessage: null }),
    ...repeat(2, () => call('bedrock', { isVlmFallback: true })),
  ];
  const warningList = buildWarningList({
    callLog, judgeBackend: 'gpu',
    judgeSourceCountMap: { ...EMPTY_JUDGE_MAP, router: { gpu: 4, bedrock: 1, error: 0 }, silence: { gpu: 1, bedrock: 0, error: 1 } },
    sessionResult: { ...OK_SESSION, isDrainTimedOut: true, drainLimitMs: 33000, remainingTaskCount: 2, inFlightCallCount: 1 },
    swallowedErrorCountMap: { task: { caption: 1 }, ipc: { 'pipeline-event': 2 } },
    incompleteReasonList: [],
  });
  assert.deepEqual(warningList, [
    { code: 'asr_timeout', count: 1, message: 'ASR 호출 시간 초과 1/11건' },
    { code: 'vlm_timeout', count: 4, message: 'VLM 호출 시간 초과 4/16건' },
    { code: 'judge_timeout', count: 1, message: '탐지 판정 GPU 호출 시간 초과 1/6건' },
    { code: 'tts_error', count: 1, message: 'TTS 호출 실패 1/3건 — HTTP 500' },
    { code: 'bedrock_error', count: 1, message: 'Bedrock 호출 실패 1/6건 — HTTP 429' },
    { code: 'judge_fallback', count: 1, message: '탐지 판정을 GPU 대신 Bedrock 이 판정 1건(router 1)' },
    { code: 'judge_error', count: 1, message: '탐지 판정 실패(LLM 없이 통과·차단) 1건(silence 1)' },
    { code: 'vlm_fallback', count: 2, message: 'VLM 대신 Bedrock 폴백 2건' },
    { code: 'drain_timeout', count: 1, message: '배수 상한(영상 끝 + 33초)에 닿아 멈춤 — 남은 작업 2 · 진행 중 호출 1' },
    { code: 'swallowed_error', count: 3, message: '연결 코드가 삼킨 오류 3건(caption 1 · ipc:pipeline-event 2)' },
  ]);
  assert.equal(formatWarningBrief(warningList), '⚠ asr_timeout 1 · vlm_timeout 4 · judge_timeout 1 · tts_error 1 · bedrock_error 1 · judge_fallback 1 · judge_error 1 · vlm_fallback 2 · drain_timeout 1 · swallowed_error 3');
  assert.equal(formatWarningBrief([]), '');
});

test('경고: 건강한 결과는 비고, 불완전 사유와 겹치는 ASR 실패·Bedrock 인증 실패는 경고로 다시 세지 않으며, Bedrock 판정 백엔드면 Bedrock 판정은 대체가 아니다', () => {
  assert.deepEqual(buildWarningList({
    callLog: [call('asr'), call('vlm'), call('tts')], judgeBackend: 'gpu', judgeSourceCountMap: EMPTY_JUDGE_MAP,
    sessionResult: OK_SESSION, swallowedErrorCountMap: { task: {}, ipc: {} }, incompleteReasonList: [],
  }), []);
  const callLog = [...repeat(3, () => refusedCall('asr')), call('bedrock', { status: 403 }), call('bedrock', { status: 403 })];
  const incompleteReasonList = buildIncompleteReasonList({ sessionResult: OK_SESSION, callLog });
  assert.deepEqual(incompleteReasonList.map((reason) => reason.code), ['asr_failure', 'bedrock_auth_failed']);
  assert.deepEqual(buildWarningList({
    callLog, judgeBackend: 'bedrock', judgeSourceCountMap: { ...EMPTY_JUDGE_MAP, router: { gpu: 0, bedrock: 3, error: 0 } },
    sessionResult: OK_SESSION, swallowedErrorCountMap: { task: {}, ipc: {} }, incompleteReasonList,
  }), []);
});
