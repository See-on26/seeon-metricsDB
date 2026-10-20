import {
  DEBUG_STAGE_MAP, DEBUG_VERDICT_MAP, NARRATION_TYPE_MAP, CANDIDATE_SOURCE_MAP, SUBMIT_RESULT_MAP, SCREEN_DEPENDENCY_REASON_MAP,
  wallToVideoTimeMs, resolveBeforeAnchorTs, judgeScreenDependency,
} from '../product/core-modules.mjs';
import { narrowToPointingRegion } from '../media/frame-source.mjs';
import { DEIXIS_FALLBACK_BEFORE_MS, DEIXIS_FALLBACK_AFTER_MS } from './renderer-constants.mjs';

// 행 번호는 seeon-meet origin/production 8ee7958 기준이다.

// main.js:996-1000
const SUBMIT_RESULT_LABEL_MAP = {
  [SUBMIT_RESULT_MAP.started]: 'look-ahead 대기',
  [SUBMIT_RESULT_MAP.absorbed]: 'look-ahead 중인 후보에 합침',
  [SUBMIT_RESULT_MAP.merged]: '판단 전 보류 중인 결정에 합침',
};

// main.js:1093-1096
const SCREEN_DEPENDENCY_LABEL_MAP = {
  [SCREEN_DEPENDENCY_REASON_MAP.speechTrigger]: '발화 지시가 트리거',
  [SCREEN_DEPENDENCY_REASON_MAP.unsupportedSource]: '발화가 아닌 출처 — 트리거로 쓰지 않는다',
};

// main.js 의 deixisDetector onDeixis(1003-1017)·resolveDeixisPointing(1019-1031)·runDeixisDecision(1098-1189).
// 지시 후보는 main 트리거가 뽑은 후보 구(candidateList)를 실어 오고, 공백(O/X)은 main 의 판단 LLM 이 후보마다 가린다.
export function createDeixisGlue({ ctx }) {
  const { clock, bridge, state, core } = ctx;

  // 직전 창에 영역이 없으면, 트리거 발화보다 앞서 같은 슬라이드에서 가리킨 영역을 붙인다(말하면서 가리킨 경우).
  // 기억은 slide-glue 의 attachPointingMotion 이 점이 움직일 때 가상 벽시계 시각으로 남기고, eventWallTs 도 가상 벽시계 값이다.
  function resolveDeixisPointing({ eventWallTs, trigger }) {
    const sequence = ctx.getPointingSequence();
    if (sequence.region) return sequence;
    const slideLabel = core.slideRegistry.currentLabel();
    const recalled = core.recentPointingMemory.recall({ eventWallTs, slideLabel });
    if (!recalled) return sequence;
    ctx.log.log(`[deixis] 직전 창에 영역 없음 → 발화 전 가리킨 영역을 붙임 트리거="${trigger}"`);
    ctx.markDebug({
      stage: DEBUG_STAGE_MAP.screenDependency, verdict: DEBUG_VERDICT_MAP.info, narrationType: NARRATION_TYPE_MAP.deixis,
      reason: '발화 전에 움직이며 가리킨 영역을 붙임', detail: `트리거="${trigger}" 슬라이드=${slideLabel || '-'}`,
    });
    return recalled;
  }

  function handleDeixis({ text, trigger, candidateList, captureTs, eventWallTs }) {
    const { region, pointingOrderHint } = resolveDeixisPointing({ eventWallTs: eventWallTs ?? captureTs, trigger });
    const nowVideoTimeMs = ctx.videoTimeMs();
    const nowTs = clock.nowPerf();
    const submitResult = core.candidateScheduler.submit({
      source: CANDIDATE_SOURCE_MAP.speech, utterance: text, trigger, candidateList, region, pointingOrderHint,
      captureTs: nowTs, videoTimeMs: nowVideoTimeMs,
      // wallToVideoTimeMs 의 기본 nowWallTs 는 실제 Date.now() 라 가상 벽시계를 넘긴다.
      eventVideoTimeMs: wallToVideoTimeMs({ wallTs: eventWallTs, nowWallTs: clock.nowWall(), nowVideoTimeMs }) ?? nowVideoTimeMs,
      leadText: core.transcriptWindow.getOpenSentenceLead({ nowTs, sinceTs: state.lastDeixisDecidedAt }),
      chunkEndWallTs: captureTs,
    });
    ctx.log.log(`[deixis] 발화 지시 "${trigger}" → ${SUBMIT_RESULT_LABEL_MAP[submitResult] || submitResult}`);
  }

  // 화면은 판정이 난 지금 뜨고(포인팅 영역이 있으면 여백을 둔 그 부분만, main.js:662-682), 판단 LLM 에는 보류(균형 2.5초)가 끝난
  // 결정(whenSealed)을 보낸다. 보류 중에 들어온 뒤 조각과 그 후보도 이 결정에 합쳐져 함께 판단을 받는다. 세션을 멈춰 후보
  // 스케줄러가 reset 되면 결정은 null 로 온다.
  async function runDeixisDecision(firedDecision) {
    state.lastDeixisDecidedAt = clock.nowPerf();
    const sessionSeq = state.experimentSeq;
    const firedRegion = firedDecision.region;
    const [buffer, decision] = await Promise.all([
      ctx.captureFrameJpeg({ normRect: firedRegion ? narrowToPointingRegion({ sub: firedRegion }) : null }),
      firedDecision.whenSealed ?? firedDecision,
    ]);
    if (!buffer || !decision) return;
    if (!state.isSessionActive || sessionSeq !== state.experimentSeq) return;
    const {
      source, utterance, triggerList, candidateList = [], region, pointingOrderHint, captureTs, eventVideoTimeMs = null,
      triggerUtterance = utterance, leadText = '', followText = '', isSentenceWaited = false, mergedChunkCount = 0,
    } = decision;
    const label = triggerList.join(', ') || '-';
    if (leadText || followText) {
      ctx.markDebug({
        stage: DEBUG_STAGE_MAP.asr, verdict: DEBUG_VERDICT_MAP.info, reason: '조각을 문장 단위로 이어 붙임',
        detail: `트리거 조각="${triggerUtterance}" → 문장="${utterance}" (앞="${leadText || '-'}" · 뒤="${followText || '-'}" · 문장 끝 추가 대기=${isSentenceWaited ? 'Y' : 'N'}`
          + `${mergedChunkCount > 0 ? ` · 판단 전 보류 중 합친 뒤 조각 ${mergedChunkCount}개` : ''})`,
      });
    }
    const { beforeMs, afterMs } = ctx.policy;
    const anchorTs = resolveBeforeAnchorTs({ mode: ctx.mode, screenTransitionTs: state.lastScreenTransitionAt });
    const { before, after, tokenCount, droppedCount } = core.transcriptWindow.getContext({
      triggerTs: captureTs, beforeMs: beforeMs ?? DEIXIS_FALLBACK_BEFORE_MS, afterMs: afterMs ?? DEIXIS_FALLBACK_AFTER_MS, anchorTs,
    });
    if (droppedCount > 0) {
      ctx.markDebug({ stage: DEBUG_STAGE_MAP.budget, verdict: DEBUG_VERDICT_MAP.info, reason: '앞 맥락이 토큰 예산으로 절삭됨', detail: `버린 발화 ${droppedCount}건 · 남은 맥락 ${tokenCount}토큰` });
    }
    const screenVerdict = judgeScreenDependency({ source, candidateList });
    if (!screenVerdict.isScreenDependent) {
      ctx.markDebug({ stage: DEBUG_STAGE_MAP.screenDependency, verdict: DEBUG_VERDICT_MAP.skip, narrationType: NARRATION_TYPE_MAP.deixis, reason: SCREEN_DEPENDENCY_LABEL_MAP[screenVerdict.reason] || screenVerdict.reason, detail: `트리거="${label}"` });
      return;
    }
    ctx.markDebug({ stage: DEBUG_STAGE_MAP.screenDependency, verdict: DEBUG_VERDICT_MAP.pass, narrationType: NARRATION_TYPE_MAP.deixis, reason: SCREEN_DEPENDENCY_LABEL_MAP[screenVerdict.reason] || screenVerdict.reason, detail: `근거="${screenVerdict.trigger || label}"` });
    const recentTranscript = [before, after].filter(Boolean).join(' ');
    const ts = clock.nowWall();
    const wordBudgetMap = ctx.buildWordBudgetMap();
    if (Object.values(wordBudgetMap).every((budget) => budget.isDroppable)) {
      ctx.markDebug({ stage: DEBUG_STAGE_MAP.budget, verdict: DEBUG_VERDICT_MAP.skip, reason: '모든 후보 유형이 어절 예산 하한 미달 → 드롭', detail: `트리거="${label}"` });
      return;
    }
    ctx.markDebug({ stage: DEBUG_STAGE_MAP.budget, verdict: DEBUG_VERDICT_MAP.pass, reason: '지시 후보 발행', detail: `트리거="${label}" 발화="${utterance || '(없음)'}" 영역=${region ? '포인팅' : '프레임 전체'} 슬라이드=${core.slideRegistry.currentLabel() || '-'}` });
    await bridge.invoke('pipeline-deixis', {
      ts, buffer: new Uint8Array(buffer), utterance, recentTranscript, beforeTranscript: before, afterTranscript: after,
      hasPointingRegion: Boolean(region), pointingOrderHint, slideLabel: core.slideRegistry.currentLabel(), wordBudgetMap, eventVideoTimeMs,
      triggerCandidateList: candidateList,
    }).catch(() => null);
    // saveDeixisFrame(main.js:1180-1184)은 화면 확인용 저장이라 공장은 하지 않는다.
  }

  ctx.hooks.onDeixis = handleDeixis;
  ctx.hooks.onDeixisDecision = (decision) => ctx.trackTask(runDeixisDecision(decision), 'deixis-decision');
  return { handleDeixis, runDeixisDecision };
}
