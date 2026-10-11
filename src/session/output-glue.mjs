import {
  DEBUG_STAGE_MAP, DEBUG_VERDICT_MAP, NARRATION_TYPE_MAP, NARRATION_CLASS_MAP, DWELL_STATE_MAP,
  resolveGapSearchFromMs, isImmediateCaption, isAnchoredCaption, isCaptionDroppable, EXCESS_DROP_MS,
  LEADER_STATUS_MAP, resolveFollowerInsertMs, resolveAfterTransitionInsertMs, QUEUE_DROP_LABEL_MAP, QUEUE_DROP_REASON_MAP,
  NarrationAudioPrefetcher,
} from '../product/core-modules.mjs';
import { readWavInfo } from '../media/wav.mjs';
import { redactUrlCredential } from '../util/redact-url-credential.mjs';
import { GAP_SAFETY_MS, CAPTION_SOURCE_TRANSITION } from './renderer-constants.mjs';

// 버린 해설의 사유(reason)는 늘 제품 사유(QUEUE_DROP_REASON_MAP)이고 main 에도 그 사유로 알린다.
// 공장은 세션을 멈춰 버린 해설(stopped)만 영상 끝(D) 기준으로 더 나눠 factoryReason 에 남긴다.
// afterEnd: 삽입 자리가 영상 끝 뒤라 지연 재생이 닿지 않거나, 배수를 다 마친 뒤 도착한 해설.
// drainTimeout: 배수 상한에 닿아 멈출 때 영상 안 자리(삽입 시각 ≤ D)였던 해설 — 더 기다렸으면 들렸을 것이다.
export const FACTORY_END_REASON_MAP = { afterEnd: 'after_end', drainTimeout: 'drain_timeout' };

// main.js:1483-1485 toNarrationType
const toNarrationType = ({ source }) => (source === CAPTION_SOURCE_TRANSITION ? NARRATION_TYPE_MAP.pageTransition : source);

// main.js:1569-1573 isTransitionFollower. 사진 단독 묘사처럼 전환 고지에 딸려 오는 캡션.
const isTransitionFollower = (payload) => payload.source !== CAPTION_SOURCE_TRANSITION
  && payload.narrationClass === NARRATION_CLASS_MAP.pageTransition && Boolean(payload.slideLabel);

// main.js:1575-1577 isSpeakerCaption
const isSpeakerCaption = (payload) => payload.narrationClass === NARRATION_CLASS_MAP.speakerIdentity;

// 재생기에 넘길 소리. 제품처럼 응답 버퍼에서 그 구간만 잘라 낸 ArrayBuffer 다(main.js:128).
const toWavArrayBuffer = (wavData) => (wavData ? wavData.buffer.slice(wavData.byteOffset, wavData.byteOffset + wavData.byteLength) : null);

// main.js:1691-1696 toNarrationEntry. 공장은 기록과 잇는 captionSeq 를 더 싣는다(main 에 보내는 알림에는 넣지 않는다).
const toNarrationEntry = (payload, record) => ({
  narrationClass: payload.narrationClass, slideLabel: payload.slideLabel ?? null, source: payload.source, text: payload.text, ts: payload.ts,
  captionSeq: record.captionSeq,
});

// main.js 의 캡션 출력 연결 코드(synthesizeEntryAudio·handleCaption·resolveInsertionTimeMs·emitCaption·applyCaption·
// scheduleNarration·reportUnplayedNarration·handleNarrationDrop)를 옮긴다. 캡션에는 소리가 없고, 재생 차례가 가까운 해설만
// NarrationAudioPrefetcher 가 pipeline-tts 로 합성한다(Orchestrator → TTS → 전달 Layer).
// 제품은 결과를 화면 카드·소리로만 남기지만, 공장은 캡션마다 기록을 만들어 넣은 자리·합성 결과·버린 사유·재생 시각을 붙인다.
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
  // 세션을 멈춘 뒤에는 합성 결과를 기록에 반영하지 않는다(settleTtsAtStop). 결과 보고서는 mp3 렌더 뒤에 만들어지므로,
  // 그 사이 늦게 온 응답이 기록을 바꾸면 집계가 렌더 시간과 TTS 지연의 경주에 따라 달라진다.
  let isTtsSettled = false;

  function registerCaption(payload, requestContext) {
    const record = {
      captionSeq: nextSeq, ts: payload.ts, text: payload.text, source: payload.source, narrationClass: payload.narrationClass ?? null,
      slideLabel: payload.slideLabel ?? null, eventVideoTimeMs: Number.isFinite(payload.eventVideoTimeMs) ? payload.eventVideoTimeMs : null,
      rationale: payload.rationale ?? null, hasAudio: false, audioDurationMs: null, wavBytes: null, tts: null, ttsTurnAtMs: null, ttsWaitMs: null,
      insertVideoTimeMs: null, gap: null, callList: requestContext?.callList ?? [],
    };
    nextSeq += 1;
    captionRecordList.push(record);
    recordBySeq.set(record.captionSeq, record);
    return record;
  }

  // main.js:123-129 synthesizeEntryAudio. 합성 실패는 null 로 받아 재생기가 tts_failed 로 버린다.
  // 공장은 결과를 기록에 붙인다: mp3 에 넣을 wav(복사 없이 참조), 성공 여부, 재생 차례가 와서 만든 것인지, 걸린 시간, 외부 호출.
  // 합성은 렌더러 작업으로 세어 배수가 그 끝을 기다린다. 세션을 멈춘 뒤 시작된 합성(정지 정리 중 미리 만들기 자리가 넘어간 것)은
  // 제품처럼 부르되 처음부터 끝나지 않은 합성(isPendingAtStop)으로 두고 결과를 기록하지 않는다.
  function synthesizeEntryAudio(entry) {
    const record = recordBySeq.get(entry.captionSeq) ?? null;
    const startedAtMs = clock.elapsedMs();
    const tts = {
      isOk: false, isSettled: false, isPendingAtStop: isTtsSettled, isOnDemand: Number.isFinite(record?.ttsTurnAtMs),
      requestedAtMs: Math.round(startedAtMs), elapsedMs: null, message: null, callList: [],
    };
    if (record) record.tts = tts;
    const promise = bridge.invokeWithContext('pipeline-tts', { ts: entry.ts, text: entry.text, source: entry.source })
      .catch((error) => ({ result: { isOk: false, message: error.message }, requestContext: null }))
      .then(({ result, requestContext }) => {
        const wavData = result?.isOk ? result.wavData : null;
        if (tts.isPendingAtStop) return toWavArrayBuffer(wavData);
        Object.assign(tts, {
          isSettled: true,
          isOk: Boolean(wavData), elapsedMs: Math.round(clock.elapsedMs() - startedAtMs),
          message: wavData ? null : redactUrlCredential(result?.message ?? '응답에 소리가 없다'), callList: requestContext?.callList ?? [],
        });
        if (!wavData) return null;
        if (record) {
          record.hasAudio = true;
          record.audioDurationMs = readWavInfo(wavData)?.durationMs ?? null;
          // 이미 버린 해설의 소리는 렌더에 쓰이지 않으므로 붙잡지 않는다.
          if (!droppedSeqSet.has(record.captionSeq)) record.wavBytes = wavData;
        }
        return toWavArrayBuffer(wavData);
      });
    ctx.trackTask(promise, 'tts');
    return promise;
  }

  // main.js:131 narrationAudio. 재생 차례가 가까운 2개는 미리 합성하고, 그보다 뒤는 앞 해설이 재생·버려질 때 차례로 만든다.
  const narrationAudio = new NarrationAudioPrefetcher({ synthesize: synthesizeEntryAudio });
  core.narrationAudio = narrationAudio;

  // main.js:134 prepareAudio. 재생 차례가 온 해설의 소리를 받는다. 미리 만든 것이 없으면 지금 만들고, 그동안 지연 재생은 멈춰 있다
  // (caption-narrator.js 가 합성 전에 회의를 멈춘다). 공장은 차례가 온 뒤 소리를 기다린 시간(그만큼 무음)을 기록에 남긴다.
  function prepareNarrationAudio(entry) {
    const record = recordBySeq.get(entry.captionSeq) ?? null;
    const turnAtMs = clock.elapsedMs();
    if (record) record.ttsTurnAtMs = turnAtMs;
    return narrationAudio.take(entry).then((wavArrayBuffer) => {
      if (record) record.ttsWaitMs = Math.round(clock.elapsedMs() - turnAtMs);
      return wavArrayBuffer;
    });
  }

  // 한 캡션은 한 번만 기록한다. 소리가 나간 적 없는 캡션의 wav 는 렌더에 쓰이지 않으므로 놓아 메모리를 줄인다.
  function addDrop({ record, reason, factoryReason = null, waitedMs = null }) {
    if (!record || droppedSeqSet.has(record.captionSeq)) return;
    droppedSeqSet.add(record.captionSeq);
    if (!playedSeqSet.has(record.captionSeq)) record.wavBytes = null;
    const { captionSeq, ts, text, source, narrationClass, slideLabel, eventVideoTimeMs } = record;
    dropRecordList.push({ captionSeq, ts, text, source, narrationClass, slideLabel, eventVideoTimeMs, reason, factoryReason, waitedMs });
  }

  // 세션을 멈춘 뒤의 stopped 를 영상 끝 기준으로 나눈다. 상한에 닿아 멈췄고 자리가 영상 안이면 drain_timeout 이다.
  function resolveFactoryReason({ reason, insertVideoTimeMs }) {
    if (reason !== QUEUE_DROP_REASON_MAP.stopped || !isEnded) return null;
    const isInsideVideo = Number.isFinite(insertVideoTimeMs) && insertVideoTimeMs <= ctx.mediaDurationMs;
    return isDrainTimedOut && isInsideVideo ? FACTORY_END_REASON_MAP.drainTimeout : FACTORY_END_REASON_MAP.afterEnd;
  }

  // main.js:1700-1716 reportUnplayedNarration. 사용자가 듣지 못한 해설은 모든 경로가 여기로 와 main 이 "말했음" 기록
  // (간격 억제·중복·재설명 금지·맥락 저장소·무발화 게이트)을 되돌리게 알리고, 미리 만들던 소리 자리를 다음 해설에 넘긴다.
  function reportUnplayedNarration({ entry, reason, waitedMs = null, detailSuffix = '', insertVideoTimeMs = null }) {
    narrationAudio.discard(entry);
    bridge.send('pipeline-narration-dropped', {
      ts: entry.ts, text: entry.text, slideLabel: entry.slideLabel, source: entry.source, narrationClass: entry.narrationClass, reason,
    });
    const record = recordBySeq.get(entry.captionSeq) ?? null;
    addDrop({
      record, reason, waitedMs,
      factoryReason: resolveFactoryReason({ reason, insertVideoTimeMs: insertVideoTimeMs ?? record?.insertVideoTimeMs ?? entry.eventTimeMs }),
    });
    const label = QUEUE_DROP_LABEL_MAP[reason] || reason;
    const waitedText = Number.isFinite(waitedMs) ? ` · 대기 ${(waitedMs / 1000).toFixed(1)}초` : '';
    ctx.log.log(`[queue] ${label} [${entry.narrationClass}] "${entry.text}"${waitedText}${detailSuffix}`);
    ctx.markDebug({
      stage: DEBUG_STAGE_MAP.queue, verdict: DEBUG_VERDICT_MAP.skip, narrationType: entry.source || null, reason: label,
      detail: `"${entry.text}" · 분류=${entry.narrationClass}`
        + `${entry.slideLabel !== null && entry.slideLabel !== undefined ? ` · 슬라이드 ${entry.slideLabel}` : ''}${waitedText}${detailSuffix}`,
    });
  }

  // main.js:1719-1721 handleNarrationDrop. 재생 대기 줄에서 버려지거나 멈춘 재생기가 버린 해설.
  function handleNarrationDrop({ entry, reason, waitedMs = null }) {
    reportUnplayedNarration({ entry, reason, waitedMs });
  }

  // main.js:1173-1177 handleCaption. 로그 카드는 없고, 전환 고지 문장 보관과 삽입 기준 시각만 남는다.
  function handleCaption({ text, source, eventVideoTimeMs = null }) {
    if (source === CAPTION_SOURCE_TRANSITION) state.lastScreenNarration = text;
    return Number.isFinite(eventVideoTimeMs) ? eventVideoTimeMs : ctx.videoTimeMs();
  }

  // main.js:1526-1566 resolveInsertionTimeMs
  // 제품은 틈 후보를 collectInsertionGapList(1493-1509)로 모으고 고른 자리를 snapInsertionToSilence(1511-1524)로 맞추는데,
  // 틈 후보 출처가 asr 이면 둘 다 ASR 후보 목록·목표 자리를 그대로 돌려준다(audio-gap-candidates.js isAudioGapActive).
  // 공장은 asr 만 옮겼다(audio 는 세션 시작 전에 막는다). 그래서 여기서는 ASR 후보 저장소를 바로 읽고 고른 자리를 그대로 쓴다.
  // 제품은 정지 때 지연 버퍼를 비워(main.js:400-411) 그 뒤 캡션은 틈 추론 없이 트리거 자리로 돌아간다.
  // 공장은 멈춘 버퍼 객체가 남으므로 정지 여부(isEnded)로 같은 길을 타 어차피 버릴 캡션에 Bedrock 을 부르지 않는다.
  async function resolveInsertionTimeMs({ payload, captionCaptureMs, record }) {
    const { delayBuffer } = core;
    if (isEnded || !delayBuffer || !Number.isFinite(captionCaptureMs)) return captionCaptureMs;
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

  // main.js:1668-1689 scheduleNarration
  function scheduleNarration({ entry, captionCaptureMs }) {
    // 세션을 멈춘 뒤 도착한 해설. 제품은 정지 때 지연 버퍼·삽입 감시를 비우므로 이 해설은 보류 게이트 → 멈춘 재생기로 가
    // stopped 로 버려진다(caption-narrator.js queueCaptionList). 공장은 같은 사유로 바로 알린다.
    if (isEnded) {
      reportUnplayedNarration({ entry, reason: QUEUE_DROP_REASON_MAP.stopped, insertVideoTimeMs: captionCaptureMs });
      return;
    }
    const { delayBuffer, narrationScheduler, narrationGate } = core;
    if (delayBuffer) {
      const excessMs = delayBuffer.getExcessMs();
      if (isCaptionDroppable({ excessMs, dropThresholdMs: EXCESS_DROP_MS })) {
        ctx.log.log(`[delay] 캡션 드롭 — 누적 지연 ${Math.round(excessMs)}ms (상한 ${EXCESS_DROP_MS}ms)`);
        reportUnplayedNarration({
          entry, reason: QUEUE_DROP_REASON_MAP.delayExceeded,
          detailSuffix: ` · 초과 ${Math.round(excessMs)}ms / 상한 ${EXCESS_DROP_MS}ms · 모드=${ctx.mode}`,
        });
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

  // main.js:1579-1619 emitCaption. entry 에 captionSeq 를 실어 합성·대기 줄 드롭·재생 시작을 기록과 잇는다.
  async function emitCaption(payload, { leaderHandle = null, record }) {
    const isFollower = isTransitionFollower(payload);
    const isSpeaker = isSpeakerCaption(payload);
    if (isSpeaker && core.pendingTransitions.hasPending) {
      ctx.markDebug({
        stage: DEBUG_STAGE_MAP.queue, verdict: DEBUG_VERDICT_MAP.info, narrationType: NARRATION_TYPE_MAP.speakerIdentity,
        reason: '진행 중인 화면 전환 고지 뒤로 화자 안내를 미룸', detail: `"${payload.text}"`,
      });
    }
    const transitionLeaderList = isSpeaker ? await core.pendingTransitions.waitAll() : [];
    const leader = isFollower ? await core.transitionOrderGate.waitLeader({ slideLabel: payload.slideLabel }) : null;
    if (isFollower && leader.status === LEADER_STATUS_MAP.cancelled) {
      reportUnplayedNarration({ entry: toNarrationEntry(payload, record), reason: QUEUE_DROP_REASON_MAP.leaderCancelled });
      return;
    }
    const captionCaptureMs = handleCaption(payload);
    const entry = { ...toNarrationEntry(payload, record), eventTimeMs: captionCaptureMs };
    // 소리는 아직 없다. 재생 차례가 가까우면 미리 만들고, 아니면 대기 줄이 고를 때 만든다.
    // 세션을 멈춘 뒤 온 캡션은 어차피 버리므로 합성을 시작하지 않는다(제품은 합성을 시작했다가 버린다 — logic-map 편차).
    if (!isEnded) narrationAudio.register(entry);
    if (isImmediateCaption(payload)) {
      leaderHandle?.settle({ status: LEADER_STATUS_MAP.unscheduled });
      core.narrator?.queueCaption({ ...entry, dueAt: clock.nowPerf() });
      return;
    }
    const ownInsertVideoTimeMs = isFollower
      ? resolveFollowerInsertMs({ eventVideoTimeMs: captionCaptureMs, leader })
      : isAnchoredCaption(payload) ? captionCaptureMs : await resolveInsertionTimeMs({ payload, captionCaptureMs, record });
    const insertVideoTimeMs = isSpeaker
      ? resolveAfterTransitionInsertMs({ insertVideoTimeMs: ownInsertVideoTimeMs, leaderList: transitionLeaderList })
      : ownInsertVideoTimeMs;
    leaderHandle?.settle({ status: LEADER_STATUS_MAP.scheduled, insertVideoTimeMs });
    record.insertVideoTimeMs = insertVideoTimeMs;
    if (insertVideoTimeMs === null) {
      reportUnplayedNarration({ entry, reason: QUEUE_DROP_REASON_MAP.leaderCancelled });
      return;
    }
    scheduleNarration({ entry, captionCaptureMs: insertVideoTimeMs });
  }

  // main.js:1621-1627 emitCaptionSafely. 제품의 console.warn 대신 trackTask 가 경고를 남기고 배수 판정용으로 센다.
  function emitCaptionSafely(payload, options) {
    ctx.trackTask(emitCaption(payload, options).catch((error) => {
      options.leaderHandle?.settle({ status: LEADER_STATUS_MAP.unscheduled });
      reportUnplayedNarration({ entry: toNarrationEntry(payload, options.record), reason: QUEUE_DROP_REASON_MAP.emitFailed });
      throw error;
    }), 'caption');
  }

  // main.js:1629-1651 applyCaption. 전환 고지의 삽입 시각이 정해지면 딸린 사진 묘사(transitionOrderGate)와
  // 기다리던 화자 안내(pendingTransitions)를 함께 풀어 준다.
  function applyCaption(payload, { record }) {
    const isTransition = payload.source === CAPTION_SOURCE_TRANSITION;
    if (!isTransition || !payload.slideLabel) { emitCaptionSafely(payload, { record }); return; }
    const orderHandle = core.transitionOrderGate.registerLeader({ slideLabel: payload.slideLabel });
    const leaderHandle = {
      settle: (result) => {
        orderHandle.settle(result);
        core.pendingTransitions.settle({ slideLabel: payload.slideLabel, ...result });
      },
    };
    if (core.slideDwellGate.getState({ label: payload.slideLabel }) === DWELL_STATE_MAP.waiting) {
      ctx.log.log(`[slide] 고지 보류 — 슬라이드 ${payload.slideLabel} 체류 판정 대기 중`);
    }
    core.slideDwellGate.whenResolved({
      label: payload.slideLabel,
      callback: (isSatisfied) => {
        if (isSatisfied) { emitCaptionSafely(payload, { leaderHandle, record }); return; }
        leaderHandle.settle({ status: LEADER_STATUS_MAP.cancelled });
        reportUnplayedNarration({ entry: toNarrationEntry(payload, record), reason: QUEUE_DROP_REASON_MAP.dwellCancelled });
      },
    });
  }

  return {
    // main.js:1653-1658 onPipelineEvent 의 caption 갈래
    handleCaptionEvent({ payload, requestContext }) {
      if (payload?.type !== 'caption') return;
      applyCaption(payload, { record: registerCaption(payload, requestContext) });
    },
    applyCaption, resolveInsertionTimeMs, scheduleNarration, handleNarrationDrop, reportUnplayedNarration, prepareNarrationAudio,
    noteAdStart({ entry, atElapsedMs, durationMs, playedMediaMs }) {
      if (entry) playedSeqSet.add(entry.captionSeq);
      adPlayList.push({ captionSeq: entry?.captionSeq ?? null, atElapsedMs, durationMs, playedMediaMs });
    },
    // 세션을 멈춘다고 표시한다. 그 뒤 재생 사슬 정리(playback-chain stop)가 남은 해설을 제품처럼 stopped 로 알리고,
    // 공장은 그 해설과 이 뒤로 오는 해설을 영상 끝 기준으로 after_end·drain_timeout 으로 나눈다.
    noteSessionEnd({ isDrainTimedOut: isTimedOut = false } = {}) {
      isEnded = true;
      isDrainTimedOut = isTimedOut;
    },
    // 재생 사슬을 정리한 직후 합성 상태를 확정한다. 그때 응답이 오지 않은 합성과 그 뒤 시작될 합성은 끝나지 않은 합성으로 남기고
    // 성공·실패 집계와 TTS 장애 판정에서 뺀다(stats.tts.pendingAtStopCount).
    settleTtsAtStop() {
      isTtsSettled = true;
      for (const record of captionRecordList) {
        if (record.tts && !record.tts.isSettled) record.tts.isPendingAtStop = true;
      }
    },
    getCaptionRecordList: () => captionRecordList,
    getDropRecordList: () => dropRecordList,
    getAdPlayList: () => adPlayList,
  };
}
