import {
  DEBUG_STAGE_MAP, DEBUG_VERDICT_MAP, NARRATION_TYPE_MAP, NARRATION_CLASS_MAP, DWELL_STATE_MAP,
  resolveGapSearchFromMs, isImmediateCaption, isAnchoredCaption, isCaptionDroppable, EXCESS_DROP_MS,
  LEADER_STATUS_MAP, resolveFollowerInsertMs, QUEUE_DROP_LABEL_MAP,
} from '../product/core-modules.mjs';
import { readWavInfo } from '../media/wav.mjs';
import { GAP_SAFETY_MS, CAPTION_SOURCE_TRANSITION } from './renderer-constants.mjs';

// 렌더러 쪽에서 해설을 버리는 사유 중 제품 대기 줄(narration-queue.js) 사유가 아닌 것.
// emitFailed 는 제품이 경고만 찍고 잃어버리는 발행 오류(main.js:1491-1496)다.
// drainTimeout 은 배수 상한에 닿아 멈출 때 영상 안 자리(삽입 시각 ≤ 영상 길이)라 더 기다렸으면 들렸을 해설이다.
// afterEnd 는 영상 끝 뒤 자리라 지연 재생이 닿지 않거나, 배수를 다 마친 뒤 도착한 해설이다.
export const FACTORY_DROP_REASON_MAP = {
  noAudio: 'no_audio', excessDelay: 'excess_delay', afterEnd: 'after_end', dwellCancelled: 'dwell_cancelled', leaderCancelled: 'leader_cancelled',
  emitFailed: 'emit_failed', drainTimeout: 'drain_timeout',
};

// main.js:1402-1404 toNarrationType
const toNarrationType = ({ source }) => (source === CAPTION_SOURCE_TRANSITION ? NARRATION_TYPE_MAP.pageTransition : source);

// main.js:1449-1453 isTransitionFollower. 사진 단독 묘사처럼 전환 고지에 딸려 오는 캡션.
const isTransitionFollower = (payload) => payload.source !== CAPTION_SOURCE_TRANSITION
  && payload.narrationClass === NARRATION_CLASS_MAP.pageTransition && Boolean(payload.slideLabel);

// main.js 의 캡션 출력 연결 코드(handleCaption·resolveInsertionTimeMs·emitCaption·applyCaption·scheduleNarration·handleNarrationDrop)를 옮긴다.
// 제품은 결과를 화면 카드·소리로만 남기지만, 공장은 캡션마다 기록을 만들어 넣은 자리·버린 사유·재생 시각을 붙인다.
export function createOutputGlue({ ctx }) {
  const { clock, bridge, state, core } = ctx;
  const captionRecordList = [];
  const recordBySeq = new Map();
  const dropRecordList = [];
  const adPlayList = [];
  const droppedSeqSet = new Set();
  const playedSeqSet = new Set();
  let nextSeq = 1;
  let isEnded = false;
  let isDrainTimedOut = false;

  // wav 는 main 이 만든 버퍼를 복사하지 않고 참조로 둔다. 재생 대기 줄에는 제품처럼 잘라 낸 ArrayBuffer 가 따로 간다.
  function registerCaption(payload, requestContext) {
    const wavBytes = payload.wavData ?? null;
    const record = {
      captionSeq: nextSeq, ts: payload.ts, text: payload.text, source: payload.source, narrationClass: payload.narrationClass ?? null,
      slideLabel: payload.slideLabel ?? null, eventVideoTimeMs: Number.isFinite(payload.eventVideoTimeMs) ? payload.eventVideoTimeMs : null,
      rationale: payload.rationale ?? null, hasAudio: Boolean(wavBytes?.length), audioDurationMs: wavBytes ? readWavInfo(wavBytes)?.durationMs ?? null : null,
      wavBytes, insertVideoTimeMs: null, gap: null, callList: requestContext?.callList ?? [],
    };
    nextSeq += 1;
    captionRecordList.push(record);
    recordBySeq.set(record.captionSeq, record);
    return record;
  }

  // 한 캡션은 한 번만 버린다. 소리가 나간 적 없는 캡션의 wav 는 렌더에 쓰이지 않으므로 놓아 메모리를 줄인다.
  function addDrop({ record, reason, waitedMs = null }) {
    if (!record || droppedSeqSet.has(record.captionSeq)) return;
    droppedSeqSet.add(record.captionSeq);
    if (!playedSeqSet.has(record.captionSeq)) record.wavBytes = null;
    const { captionSeq, ts, text, source, narrationClass, slideLabel, eventVideoTimeMs } = record;
    dropRecordList.push({ captionSeq, ts, text, source, narrationClass, slideLabel, eventVideoTimeMs, reason, waitedMs });
  }

  // main.js:1092-1096 handleCaption. 로그 카드는 없고, 전환 고지 문장 보관과 삽입 기준 시각만 남는다.
  function handleCaption({ text, source, eventVideoTimeMs = null }) {
    if (source === CAPTION_SOURCE_TRANSITION) state.lastScreenNarration = text;
    return Number.isFinite(eventVideoTimeMs) ? eventVideoTimeMs : ctx.videoTimeMs();
  }

  // main.js:1406-1446 resolveInsertionTimeMs
  async function resolveInsertionTimeMs({ payload, captionCaptureMs, record }) {
    const { delayBuffer } = core;
    if (!delayBuffer || !Number.isFinite(captionCaptureMs)) return captionCaptureMs;
    const narrationType = toNarrationType({ source: payload.source });
    const gapList = core.gapCandidateStore.getCandidateList({
      triggerVideoTimeMs: captionCaptureMs,
      fromVideoTimeMs: resolveGapSearchFromMs({
        eventVideoTimeMs: captionCaptureMs, delayedTimeMs: delayBuffer.getDelayedTimeMs(), safetyMs: GAP_SAFETY_MS,
        isBeforeAllowed: narrationType === NARRATION_TYPE_MAP.speakerIdentity,
      }),
      toVideoTimeMs: ctx.videoTimeMs(),
    });
    if (!gapList.length) {
      ctx.markDebug({
        stage: DEBUG_STAGE_MAP.gap, verdict: DEBUG_VERDICT_MAP.skip, narrationType, reason: '후보 틈 없음 → 트리거 지점 삽입',
        detail: `"${payload.text}" · 재생 ${Math.round(delayBuffer.getDelayedTimeMs())}ms · 트리거 ${Math.round(captionCaptureMs)}ms`,
      });
      return captionCaptureMs;
    }
    const rationale = [payload.rationale?.utterance ? `발화="${payload.rationale.utterance}"` : '', payload.rationale?.summary || ''].filter(Boolean).join(' · ');
    // 제품은 inferInsertionGap(preload viewer.js:75) 실패를 null 로 받는다. 공장은 그 요청의 외부 호출 기록도 함께 받는다.
    const { result, requestContext } = await bridge.invokeWithContext('pipeline-gap', {
      mode: ctx.mode, ts: payload.ts, narrationText: payload.text, narrationType, subKind: payload.rationale?.subKind || null, rationale,
      screenSummary: [payload.slideLabel ? `슬라이드 ${payload.slideLabel}` : '', state.lastScreenNarration].filter(Boolean).join(' — '),
      gapList,
    }).catch(() => ({ result: null, requestContext: null }));
    const chosen = Number.isInteger(result?.gapIndex) ? gapList[result.gapIndex] : null;
    record.gap = {
      source: result?.source ?? null, reason: result?.reason ?? null, gapIndex: result?.gapIndex ?? null,
      candidateCount: gapList.length, callList: requestContext?.callList ?? [],
    };
    if (!chosen) return captionCaptureMs;
    ctx.log.log(`[gap] 삽입 위치 ${Math.round(captionCaptureMs)}ms → ${Math.round(chosen.videoTimeMs)}ms`
      + ` (${chosen.offsetMs >= 0 ? '+' : ''}${(chosen.offsetMs / 1000).toFixed(1)}초, ${result.source}) "${result.reason}"`);
    return chosen.videoTimeMs;
  }

  // 세션을 멈춘 뒤 남은·도착한 해설의 사유. 상한에 닿아 멈췄고 자리가 영상 안이면 drain_timeout 이다.
  function resolveEndDropReason(insertVideoTimeMs) {
    const isInsideVideo = Number.isFinite(insertVideoTimeMs) && insertVideoTimeMs <= ctx.mediaDurationMs;
    return isDrainTimedOut && isInsideVideo ? FACTORY_DROP_REASON_MAP.drainTimeout : FACTORY_DROP_REASON_MAP.afterEnd;
  }

  // main.js:1536-1559 scheduleNarration
  function scheduleNarration({ entry, captionCaptureMs, record }) {
    // 영상 끝 배수가 끝난 뒤 도착한 해설은 들려줄 자리가 없다. 제품은 정지 뒤 소리 없이 사라지지만 공장은 사유를 남긴다.
    if (isEnded) {
      addDrop({ record, reason: resolveEndDropReason(captionCaptureMs) });
      return;
    }
    const { delayBuffer, narrationScheduler, narrationGate } = core;
    if (delayBuffer) {
      const excessMs = delayBuffer.getExcessMs();
      if (isCaptionDroppable({ excessMs, dropThresholdMs: EXCESS_DROP_MS })) {
        ctx.log.log(`[delay] 캡션 드롭 — 누적 지연 ${Math.round(excessMs)}ms (상한 ${EXCESS_DROP_MS}ms)`);
        ctx.markDebug({
          stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.skip, reason: '누적 지연 상한 초과 — 캡션 드롭',
          detail: `초과 ${Math.round(excessMs)}ms / 상한 ${EXCESS_DROP_MS}ms · 모드=${ctx.mode} · 회수되면 다시 받는다`,
        });
        // 제품은 이 드롭을 main 에 알리지 않는다(reportNarrationDropped 없음). 공장도 기록만 한다.
        addDrop({ record, reason: FACTORY_DROP_REASON_MAP.excessDelay });
        return;
      }
    }
    if (!narrationScheduler || !Number.isFinite(captionCaptureMs)) {
      narrationGate.submit({ ...entry, dueAt: clock.nowPerf() });
      return;
    }
    const waitMs = Math.max(0, captionCaptureMs - delayBuffer.getDelayedTimeMs());
    if (waitMs > 0) ctx.log.log(`[delay] 캡션 삽입 대기 ~${Math.round(waitMs)}ms (영상 ${Math.round(captionCaptureMs)}ms 지점)`);
    narrationScheduler.schedule({ entry, captionCaptureMs });
  }

  // main.js:1455-1489 emitCaption. entry 에 captionSeq 를 실어 대기 줄 드롭·재생 시작을 기록과 잇는다.
  async function emitCaption(payload, { leaderHandle = null, record }) {
    const isFollower = isTransitionFollower(payload);
    const leader = isFollower ? await core.transitionOrderGate.waitLeader({ slideLabel: payload.slideLabel }) : null;
    if (isFollower && leader.status === LEADER_STATUS_MAP.cancelled) {
      ctx.markDebug({
        stage: DEBUG_STAGE_MAP.slide, verdict: DEBUG_VERDICT_MAP.skip, narrationType: NARRATION_TYPE_MAP.visualDescription,
        reason: '전환 고지 취소 — 딸린 사진 묘사도 버림', detail: `슬라이드 ${payload.slideLabel} "${payload.text}"`,
      });
      addDrop({ record, reason: FACTORY_DROP_REASON_MAP.leaderCancelled });
      return;
    }
    const captionCaptureMs = handleCaption(payload);
    if (!payload.wavData) {
      leaderHandle?.settle({ status: LEADER_STATUS_MAP.unscheduled });
      addDrop({ record, reason: FACTORY_DROP_REASON_MAP.noAudio });
      return;
    }
    const entry = {
      wavArrayBuffer: payload.wavData.buffer.slice(payload.wavData.byteOffset, payload.wavData.byteOffset + payload.wavData.byteLength),
      narrationClass: payload.narrationClass, slideLabel: payload.slideLabel ?? null, source: payload.source, text: payload.text,
      ts: payload.ts, eventTimeMs: captionCaptureMs, captionSeq: record.captionSeq,
    };
    if (isImmediateCaption(payload)) {
      leaderHandle?.settle({ status: LEADER_STATUS_MAP.unscheduled });
      core.narrator?.queueCaption({ ...entry, dueAt: clock.nowPerf() });
      return;
    }
    const insertVideoTimeMs = isFollower
      ? resolveFollowerInsertMs({ eventVideoTimeMs: captionCaptureMs, leader })
      : isAnchoredCaption(payload) ? captionCaptureMs : await resolveInsertionTimeMs({ payload, captionCaptureMs, record });
    leaderHandle?.settle({ status: LEADER_STATUS_MAP.scheduled, insertVideoTimeMs });
    record.insertVideoTimeMs = insertVideoTimeMs;
    if (insertVideoTimeMs === null) {
      addDrop({ record, reason: FACTORY_DROP_REASON_MAP.leaderCancelled });
      return;
    }
    scheduleNarration({ entry, captionCaptureMs: insertVideoTimeMs, record });
  }

  // main.js:1491-1496 emitCaptionSafely. 제품의 console.warn 대신 trackTask 가 경고를 남기고 배수 판정용으로 센다.
  // 실패한 캡션은 재생도 드롭도 아닌 채 남지 않게 emit_failed 로 버린다.
  function emitCaptionSafely(payload, options) {
    ctx.trackTask(emitCaption(payload, options).catch((error) => {
      options.leaderHandle?.settle({ status: LEADER_STATUS_MAP.unscheduled });
      addDrop({ record: options.record, reason: FACTORY_DROP_REASON_MAP.emitFailed });
      throw error;
    }), 'caption');
  }

  // main.js:1498-1519 applyCaption
  function applyCaption(payload, { record }) {
    const isTransition = payload.source === CAPTION_SOURCE_TRANSITION;
    if (!isTransition || !payload.slideLabel) { emitCaptionSafely(payload, { record }); return; }
    const leaderHandle = core.transitionOrderGate.registerLeader({ slideLabel: payload.slideLabel });
    if (core.slideDwellGate.getState({ label: payload.slideLabel }) === DWELL_STATE_MAP.waiting) {
      ctx.log.log(`[slide] 고지 보류 — 슬라이드 ${payload.slideLabel} 체류 판정 대기 중`);
    }
    core.slideDwellGate.whenResolved({
      label: payload.slideLabel,
      callback: (isSatisfied) => {
        if (isSatisfied) { emitCaptionSafely(payload, { leaderHandle, record }); return; }
        leaderHandle.settle({ status: LEADER_STATUS_MAP.cancelled });
        addDrop({ record, reason: FACTORY_DROP_REASON_MAP.dwellCancelled });
        ctx.markDebug({
          stage: DEBUG_STAGE_MAP.slide, verdict: DEBUG_VERDICT_MAP.skip, narrationType: NARRATION_TYPE_MAP.pageTransition,
          reason: '체류 미달 — 재생 전 취소(선판정 후취소)', detail: `슬라이드 ${payload.slideLabel} "${payload.text}"`,
        });
      },
    });
  }

  // main.js:1562-1577 handleNarrationDrop. 대기 줄에서 버려지거나 끊긴 해설을 main 에 알려 중복 억제·재설명 금지 기록을 되돌리게 한다.
  function handleNarrationDrop({ entry, reason, waitedMs = null }) {
    bridge.send('pipeline-narration-dropped', {
      ts: entry.ts, text: entry.text, slideLabel: entry.slideLabel, source: entry.source, narrationClass: entry.narrationClass, reason,
    });
    addDrop({ record: recordBySeq.get(entry.captionSeq), reason, waitedMs });
    const label = QUEUE_DROP_LABEL_MAP[reason] || reason;
    const waitedText = Number.isFinite(waitedMs) ? ` · 대기 ${(waitedMs / 1000).toFixed(1)}초` : '';
    ctx.log.log(`[queue] ${label} [${entry.narrationClass}] "${entry.text}"${waitedText}`);
    ctx.markDebug({
      stage: DEBUG_STAGE_MAP.queue, verdict: DEBUG_VERDICT_MAP.skip, narrationType: entry.source || null, reason: label,
      detail: `"${entry.text}" · 분류=${entry.narrationClass}${entry.slideLabel !== null ? ` · 슬라이드 ${entry.slideLabel}` : ''}${waitedText}`,
    });
  }

  return {
    // main.js:1521-1526 onPipelineEvent 의 caption 갈래
    handleCaptionEvent({ payload, requestContext }) {
      if (payload?.type !== 'caption') return;
      applyCaption(payload, { record: registerCaption(payload, requestContext) });
    },
    applyCaption, resolveInsertionTimeMs, scheduleNarration, handleNarrationDrop,
    noteAdStart({ entry, atElapsedMs, durationMs, playedMediaMs }) {
      if (entry) playedSeqSet.add(entry.captionSeq);
      adPlayList.push({ captionSeq: entry?.captionSeq ?? null, atElapsedMs, durationMs, playedMediaMs });
    },
    // 세션을 멈출 때 남은 예약·대기 해설을 버린다. 배수를 다 마쳤으면 남은 예약은 영상 끝 뒤 자리뿐이다(after_end).
    // 상한에 닿아 멈췄으면 영상 안 자리 예약과 이미 삽입 시점이 온 대기 줄 해설은 drain_timeout 이다. 이 뒤로 오는 해설도 같은 규칙이다.
    dropPendingAfterEnd({ isDrainTimedOut: isTimedOut = false } = {}) {
      isEnded = true;
      isDrainTimedOut = isTimedOut;
      for (const item of core.narrationScheduler?.pendingList ?? []) {
        addDrop({ record: recordBySeq.get(item.entry.captionSeq), reason: resolveEndDropReason(item.captionCaptureMs) });
      }
      const queueReason = isDrainTimedOut ? FACTORY_DROP_REASON_MAP.drainTimeout : FACTORY_DROP_REASON_MAP.afterEnd;
      for (const entry of core.narrator?.queue?.entryList ?? []) addDrop({ record: recordBySeq.get(entry.captionSeq), reason: queueReason });
      core.narrationScheduler?.reset();
      core.narrator?.queue?.clear();
    },
    getCaptionRecordList: () => captionRecordList,
    getDropRecordList: () => dropRecordList,
    getAdPlayList: () => adPlayList,
  };
}
