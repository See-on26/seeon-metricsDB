import {
  DelayBuffer, NarrationScheduler, CaptionNarrator, NarrationHoldGate, getCatchupRateRange, QUEUE_DROP_REASON_MAP, DEBUG_STAGE_MAP, DEBUG_VERDICT_MAP,
} from '../product/core-modules.mjs';
import { FakeDelaySource, FakeAudioContext, createFakeCaptureStream } from './fake-media.mjs';

// 교차 모드의 재생 사슬을 세운다: 지연 재생(DelayBuffer) → 삽입 시점 감시(NarrationScheduler) → 보류 게이트 → CaptionNarrator.
// main.js 의 startDelayBufferIfNeeded(295-348)·startNarrationPlayer(272-288)·모듈 범위 CaptionNarrator(133-141)·narrationGate(146-149) 를 옮긴다.
// 브라우저 쪽(StreamDelaySource·<audio>·AudioContext·캡처 스트림)만 대역이고 클래스는 제품 그대로다.
// prepareAudio 는 재생 차례가 온 해설의 소리를 주는 함수다(main.js:134 narrationAudio.take). 기본은 출력 연결 코드가 core 에 둔 prefetcher 다.
export function startPlaybackChain({
  ctx, recorder, onAdStart = () => {}, onAdStop = () => {}, onNarrationDrop = () => {}, prepareAudio = (entry) => ctx.core.narrationAudio.take(entry),
}) {
  const { clock, policy, core, mode } = ctx;
  const delaySource = new FakeDelaySource({
    clock, getVideoTimeMs: () => ctx.videoTimeMs(), mediaDurationMs: ctx.mediaDurationMs, targetDelayMs: policy.delayMs,
    onElementChange: (event) => recorder.handleElementChange(event),
  });
  const delayBuffer = new DelayBuffer({
    source: delaySource, targetDelayMs: policy.delayMs, rateMin: policy.rateMin, rateMax: policy.rateMax, ...ctx.intervalDeps,
  });
  delayBuffer.start({ fromTimeMs: null });
  const chain = { delaySource, delayBuffer, narrationScheduler: null, narrator: null, narrationGate: null };

  chain.narrator = new CaptionNarrator({
    prepareAudio,
    getLiveVideo: () => delayBuffer.delayedVideo,
    onDrop: onNarrationDrop,
    isEntryEnabled: (entry) => ctx.featureToggleStore.isClassOn(entry.narrationClass),
    getRateRange: () => getCatchupRateRange({ mode }),
    // 교차 모드는 따라잡기를 DelayBuffer 가 맡는다(main.js:140). 그래서 CaptionNarrator 의 실제 setTimeout 따라잡기(caption-narrator.js:245)는 돌지 않는다.
    isCatchupDelegated: () => true,
    now: () => clock.nowPerf(),
    createAudioContext: () => new FakeAudioContext({
      clock,
      onSourceStart: ({ atElapsedMs, durationMs }) => {
        const entry = chain.narrator.currentEntry;
        recorder.handleAdStart({ adRef: entry?.captionSeq ?? null, atElapsedMs, durationMs });
        onAdStart({ entry, atElapsedMs, durationMs, playedMediaMs: delayBuffer.getDelayedTimeMs() });
      },
      onSourceStop: ({ atElapsedMs, isEnded }) => {
        recorder.handleAdStop({ atElapsedMs });
        onAdStop({ atElapsedMs, isEnded });
      },
    }),
  });
  chain.narrationGate = new NarrationHoldGate({
    deliver: (entry) => chain.narrator.queueCaption(entry),
    deliverList: (entryList) => chain.narrator.queueCaptionList(entryList),
  });
  chain.narrationScheduler = new NarrationScheduler({
    getPlaybackTimeMs: () => delayBuffer.getDelayedTimeMs(),
    onDue: ({ entry, captionCaptureMs }) => {
      ctx.log.log(`[delay] 삽입 시점 도달 (영상 ${Math.round(captionCaptureMs)}ms 지점)`);
      chain.narrationGate.submit({ ...entry, dueAt: clock.nowPerf() });
    },
    ...ctx.intervalDeps,
  });
  chain.narrationScheduler.start();
  ctx.log.log(`[delay] 지연 버퍼 시작 — 목표 ${policy.delayMs}ms, 배속 ${policy.rateMin}~${policy.rateMax}`);
  ctx.markDebug({
    stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.info, reason: '지연 버퍼 시작',
    detail: `모드=${mode} 목표 지연=${policy.delayMs}ms · 버퍼가 찰 때까지 화면·소리가 나오지 않는 것이 정상`,
  });
  // startNarrationPlayer 의 교차 모드 갈래. 가짜 스트림은 오디오 트랙이 없어 파형 탭을 만들지 않는다.
  chain.narrator.start(createFakeCaptureStream());
  Object.assign(core, chain);

  return {
    ...chain,
    // stopExperiment(main.js:1954-2015) 의 내레이션 출력기 → 해설 보류 게이트(+ 미리 만들기 비움) → 지연 버퍼(stopDelayBuffer 400-411)
    // 순서로 정리한다. 재생하지 못한 해설(소리 나기 전 해설·대기 줄·보류·삽입 대기)은 제품처럼 모두 stopped 로 알린다.
    stop() {
      chain.narrator.stop();
      for (const entry of chain.narrationGate.clear()) onNarrationDrop({ entry, reason: QUEUE_DROP_REASON_MAP.stopped });
      core.narrationAudio?.reset();
      for (const item of chain.narrationScheduler.reset()) onNarrationDrop({ entry: item.entry, reason: QUEUE_DROP_REASON_MAP.stopped });
      delayBuffer.stop();
    },
  };
}
