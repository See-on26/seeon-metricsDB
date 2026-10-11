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

test('불완전: 렌더러가 해설 소리를 요청(pipeline-tts)했는데 하나도 만들지 못하면(TTS 장애) 불완전이고, 일부만 실패하면 경고로만 남긴다', () => {
  // 캡션에는 소리가 없고 렌더러가 재생 차례가 가까운 해설만 합성한다. tts 는 그 합성 결과, null 은 합성 차례가 오기 전에 버려진 해설이다.
  const caption = (tts) => ({ captionSeq: 1, hasAudio: Boolean(tts?.isOk), tts });
  const ttsOk = { isOk: true, message: null };
  const ttsFailed = (message = 'TTS HTTP 500') => ({ isOk: false, message });
  const ttsDownSession = { ...OK_SESSION, captionRecordList: [caption(ttsFailed()), caption(ttsFailed()), caption(null)] };
  const ttsDownLog = [call('tts', { status: 500 }), refusedCall('tts')];
  const reasonList = buildIncompleteReasonList({ sessionResult: ttsDownSession, callLog: ttsDownLog });
  assert.deepEqual(reasonList, [{ code: 'tts_unavailable', narrationCount: 3, count: 2, total: 2, message: 'HTTP 500' }]);
  assert.equal(describeIncompleteReason(reasonList[0]), 'TTS 장애 — 해설 3개 중 소리를 만든 해설 없음(TTS 실패 2/2건) — HTTP 500');
  // 합성 요청이 하나뿐이어도 그 해설이 소리를 잃으면 결과 mp3 에 AD 가 없다. 호출 기록이 없으면 제품 핸들러의 실패 문구를 쓴다.
  const singleReason = buildIncompleteReasonList({ sessionResult: { ...OK_SESSION, captionRecordList: [caption(ttsFailed('TTS 응답 없음'))] }, callLog: [] })[0];
  assert.deepEqual(singleReason, { code: 'tts_unavailable', narrationCount: 1, count: 1, total: 1, message: 'TTS 응답 없음' });

  const partialSession = { ...OK_SESSION, captionRecordList: [caption(ttsOk), caption(ttsFailed()), caption(ttsFailed())] };
  const partialLog = [call('tts'), call('tts', { status: 500 }), call('tts', { status: 500 })];
  assert.deepEqual(buildIncompleteReasonList({ sessionResult: partialSession, callLog: partialLog }), [], '소리를 만든 해설이 하나라도 있으면 완료');
  assert.deepEqual(buildIncompleteReasonList({ sessionResult: { ...OK_SESSION, captionRecordList: [] }, callLog: [] }), [], '해설이 없는 영상');
  assert.deepEqual(buildIncompleteReasonList({ sessionResult: { ...OK_SESSION, captionRecordList: [caption(null)] }, callLog: [] }), [],
    '합성 차례가 오기 전에 버려진 해설(체류 미달 등)만 있으면 TTS 장애가 아니다');
  // 세션을 멈출 때 끝나지 않은 합성은 성공도 실패도 아니라 판정에서 뺀다.
  const pendingAtStop = { isOk: false, isSettled: false, isPendingAtStop: true, message: null };
  assert.deepEqual(buildIncompleteReasonList({ sessionResult: { ...OK_SESSION, captionRecordList: [caption(pendingAtStop)] }, callLog: [] }), [],
    '끝나지 않은 합성만 있으면 판정하지 않는다');
  assert.deepEqual(buildIncompleteReasonList({ sessionResult: { ...OK_SESSION, captionRecordList: [caption(ttsFailed()), caption(pendingAtStop)] }, callLog: [] }),
    [{ code: 'tts_unavailable', narrationCount: 2, count: 1, total: 1, message: 'TTS HTTP 500' }], '확정된 합성만 센다');
  assert.deepEqual(buildWarningList({
    callLog: partialLog, judgeBackend: 'gpu', judgeSourceCountMap: EMPTY_JUDGE_MAP, sessionResult: partialSession,
    swallowedErrorCountMap: { task: {}, ipc: {} }, incompleteReasonList: [],
  }), [{ code: 'tts_error', count: 2, message: 'TTS 호출 실패 2/3건 — HTTP 500' }]);
  assert.deepEqual(buildWarningList({
    callLog: ttsDownLog, judgeBackend: 'gpu', judgeSourceCountMap: EMPTY_JUDGE_MAP, sessionResult: ttsDownSession,
    swallowedErrorCountMap: { task: {}, ipc: {} }, incompleteReasonList: reasonList,
  }), [], '불완전 사유로 센 TTS 실패는 경고로 다시 세지 않는다');
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
    { code: 'judge_error', count: 1, message: '탐지 판정 실패(GPU·Bedrock 모두) 1건(silence 1) — 라우터·무발화 판정은 해설을 내지 않는다' },
    { code: 'vlm_fallback', count: 2, message: 'VLM 대신 Bedrock 폴백 2건' },
    { code: 'drain_timeout', count: 1, message: '배수 상한(영상 끝 + 33초)에 닿아 멈춤 — 남은 작업 2 · 진행 중 호출 1' },
    { code: 'swallowed_error', count: 3, message: '연결 코드가 삼킨 오류 3건(caption 1 · ipc:pipeline-event 2)' },
  ]);
  assert.equal(formatWarningBrief(warningList), '⚠ asr_timeout 1 · vlm_timeout 4 · judge_timeout 1 · tts_error 1 · bedrock_error 1 · judge_fallback 1 · judge_error 1 · vlm_fallback 2 · drain_timeout 1 · swallowed_error 3');
  assert.equal(formatWarningBrief([]), '');
});

const slideTextOf = ({ ocr = 0, vlm = 0, lowScore = 0, verticalText = 0, ocrError = 0, ocrBypass = 0 }) => ({
  count: ocr + vlm, statusCountMap: { ready: ocr + vlm }, sourceCountMap: { ocr, vlm },
  fallbackReasonCountMap: { low_score: lowScore, vertical_text: verticalText, ocr_error: ocrError, ocr_bypass: ocrBypass },
});
const HEALTHY_WARNING_INPUT = { judgeBackend: 'gpu', judgeSourceCountMap: EMPTY_JUDGE_MAP, sessionResult: OK_SESSION, swallowedErrorCountMap: { task: {}, ipc: {} } };

test('불완전·경고: ocr 백엔드에서 OCR 이 죽어 OCR 로 읽은 장이 없으면 불완전(ocr_unavailable), 일부만 넘겼으면 경고(ocr_fallback)다', () => {
  const ocrDownLog = [call('ocr', { status: 503 }), call('vlm'), call('vlm'), call('vlm')];
  // 도중에 OCR 이 죽음: 첫 장은 오류, 나머지는 60초 우회로 모두 VLM.
  const downSlideText = slideTextOf({ vlm: 3, ocrError: 1, ocrBypass: 2 });
  const downReasonList = buildIncompleteReasonList({ sessionResult: OK_SESSION, callLog: ocrDownLog, slideTextBackend: 'ocr', slideText: downSlideText });
  assert.deepEqual(downReasonList, [{ code: 'ocr_unavailable', count: 3, total: 3, message: 'HTTP 503' }]);
  assert.equal(describeIncompleteReason(downReasonList[0]), 'OCR 장애 — 슬라이드 전사 3장 중 OCR 로 읽은 장 없음(OCR 오류·우회로 VLM 으로 넘김 3장) — HTTP 503');
  assert.deepEqual(buildWarningList({
    ...HEALTHY_WARNING_INPUT, callLog: ocrDownLog, incompleteReasonList: downReasonList, slideTextBackend: 'ocr', slideText: downSlideText,
  }), [], '불완전으로 센 OCR 실패는 경고로 다시 세지 않는다');

  // 몇 장을 OCR 로 읽은 뒤 죽음: 완료이고 경고로 남긴다.
  const partialSlideText = slideTextOf({ ocr: 2, vlm: 3, lowScore: 1, ocrError: 1, ocrBypass: 1 });
  const partialLog = [call('ocr'), call('ocr'), call('ocr'), call('ocr', { status: 503 })];
  const partialReasonList = buildIncompleteReasonList({ sessionResult: OK_SESSION, callLog: partialLog, slideTextBackend: 'ocr', slideText: partialSlideText });
  assert.deepEqual(partialReasonList, []);
  assert.deepEqual(buildWarningList({
    ...HEALTHY_WARNING_INPUT, callLog: partialLog, incompleteReasonList: partialReasonList, slideTextBackend: 'ocr', slideText: partialSlideText,
  }), [
    { code: 'ocr_error', count: 1, message: 'OCR 호출 실패 1/4건 — HTTP 503' },
    { code: 'ocr_fallback', count: 2, message: 'OCR 오류·우회로 VLM 으로 넘긴 슬라이드 2/5장(ocr_error 1 · ocr_bypass 1)' },
  ]);

  // OCR 은 답했지만 모두 저신뢰·세로 글씨라 넘긴 것은 장애가 아니다. vlm 백엔드도 보지 않는다.
  const lowScoreSlideText = slideTextOf({ vlm: 3, lowScore: 2, verticalText: 1 });
  for (const option of [{ slideTextBackend: 'ocr', slideText: lowScoreSlideText }, { slideTextBackend: 'vlm', slideText: downSlideText }, {}]) {
    const reasonList = buildIncompleteReasonList({ sessionResult: OK_SESSION, callLog: [], ...option });
    assert.deepEqual(reasonList, [], JSON.stringify(option));
    assert.deepEqual(buildWarningList({ ...HEALTHY_WARNING_INPUT, callLog: [], incompleteReasonList: reasonList, ...option }), [], JSON.stringify(option));
  }
});

test('경고: OCR 호출 시간 초과·실패는 VLM 뒤에 OCR 경고로 센다(그 장은 제품이 VLM 으로 넘겨 전사한다)', () => {
  const warningList = buildWarningList({
    callLog: [call('vlm'), timeoutCall('vlm'), call('ocr'), timeoutCall('ocr'), call('ocr', { status: 422 }), call('judge')],
    judgeBackend: 'gpu', judgeSourceCountMap: EMPTY_JUDGE_MAP, sessionResult: OK_SESSION,
    swallowedErrorCountMap: { task: {}, ipc: {} }, incompleteReasonList: [],
  });
  assert.deepEqual(warningList, [
    { code: 'vlm_timeout', count: 1, message: 'VLM 호출 시간 초과 1/2건' },
    { code: 'ocr_timeout', count: 1, message: 'OCR 호출 시간 초과 1/3건' },
    { code: 'ocr_error', count: 1, message: 'OCR 호출 실패 1/3건 — HTTP 422' },
  ]);
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
