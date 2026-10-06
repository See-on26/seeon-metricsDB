import {
  DEBUG_STAGE_MAP, DEBUG_VERDICT_MAP, NARRATION_TYPE_MAP, CANDIDATE_SOURCE_MAP, SCREEN_DEPENDENCY_REASON_MAP,
  wallToVideoTimeMs, computeContextHoldMs, resolveBeforeAnchorTs, judgeScreenDependency,
} from '../product/core-modules.mjs';
import { narrowToPointingRegion } from '../media/frame-source.mjs';
import { DEIXIS_FALLBACK_BEFORE_MS, DEIXIS_FALLBACK_AFTER_MS } from './renderer-constants.mjs';

// main.js:939-942
const SCREEN_DEPENDENCY_LABEL_MAP = {
  [SCREEN_DEPENDENCY_REASON_MAP.speechTrigger]: '발화 지시가 트리거',
  [SCREEN_DEPENDENCY_REASON_MAP.unsupportedSource]: '발화가 아닌 출처 — 트리거로 쓰지 않는다',
};

// main.js 의 deixisDetector onDeixis(870-883)·runDeixisDecision(944-1035).
export function createDeixisGlue({ ctx }) {
  const { clock, bridge, state, core } = ctx;

  function handleDeixis({ text, trigger, captureTs, eventWallTs }) {
    const { region, pointingOrderHint } = ctx.getPointingSequence();
    ctx.log.log(`[deixis] 발화 지시 "${trigger}" → look-ahead 대기`);
    const nowVideoTimeMs = ctx.videoTimeMs();
    const nowTs = clock.nowPerf();
    core.candidateScheduler.submit({
      source: CANDIDATE_SOURCE_MAP.speech, utterance: text, trigger, region, pointingOrderHint,
      captureTs: nowTs, videoTimeMs: nowVideoTimeMs,
      // wallToVideoTimeMs 의 기본 nowWallTs 는 실제 Date.now() 라 가상 벽시계를 넘긴다.
      eventVideoTimeMs: wallToVideoTimeMs({ wallTs: eventWallTs, nowWallTs: clock.nowWall(), nowVideoTimeMs }) ?? nowVideoTimeMs,
      leadText: core.transcriptWindow.getOpenSentenceLead({ nowTs, sinceTs: state.lastDeixisDecidedAt }),
      chunkEndWallTs: captureTs,
    });
  }

  async function runDeixisDecision({ source, utterance, triggerList, region, pointingOrderHint, captureTs,
    eventVideoTimeMs = null, triggerUtterance = utterance, leadText = '', followText = '', isSentenceWaited = false }) {
    state.lastDeixisDecidedAt = clock.nowPerf();
    const label = triggerList.join(', ') || '-';
    if (leadText || followText) {
      ctx.markDebug({
        stage: DEBUG_STAGE_MAP.asr, verdict: DEBUG_VERDICT_MAP.info, reason: '조각을 문장 단위로 이어 붙임',
        detail: `트리거 조각="${triggerUtterance}" → 문장="${utterance}" (앞="${leadText || '-'}" · 뒤="${followText || '-'}" · 문장 끝 추가 대기=${isSentenceWaited ? 'Y' : 'N'})`,
      });
    }
    const { beforeMs, afterMs } = ctx.policy;
    // 판정 시점 화면을 뜬다. 포인팅 영역이 있으면 여백을 둔 그 부분만(main.js:960, 588-592).
    const buffer = await ctx.captureFrameJpeg({ normRect: region ? narrowToPointingRegion({ sub: region }) : null });
    if (!buffer) return;
    const holdMs = computeContextHoldMs({ mode: ctx.mode });
    if (holdMs > 0) {
      const sessionSeq = state.experimentSeq;
      await ctx.waitVirtual(holdMs);
      if (!state.isSessionActive || sessionSeq !== state.experimentSeq) return;
    }
    const anchorTs = resolveBeforeAnchorTs({ mode: ctx.mode, screenTransitionTs: state.lastScreenTransitionAt });
    const { before, after, tokenCount, droppedCount } = core.transcriptWindow.getContext({
      triggerTs: captureTs, beforeMs: beforeMs ?? DEIXIS_FALLBACK_BEFORE_MS, afterMs: afterMs ?? DEIXIS_FALLBACK_AFTER_MS, anchorTs,
    });
    if (droppedCount > 0) {
      ctx.markDebug({ stage: DEBUG_STAGE_MAP.budget, verdict: DEBUG_VERDICT_MAP.info, reason: '앞 맥락이 토큰 예산으로 절삭됨', detail: `버린 발화 ${droppedCount}건 · 남은 맥락 ${tokenCount}토큰` });
    }
    const screenVerdict = judgeScreenDependency({ source, utterance: triggerUtterance });
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
    }).catch(() => null);
    // saveDeixisFrame(main.js:1026-1030)은 화면 확인용 저장이라 공장은 하지 않는다.
  }

  ctx.hooks.onDeixis = handleDeixis;
  ctx.hooks.onDeixisDecision = (decision) => ctx.trackTask(runDeixisDecision(decision), 'deixis-decision');
  return { handleDeixis, runDeixisDecision };
}
