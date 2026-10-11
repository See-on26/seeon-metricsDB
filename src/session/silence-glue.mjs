import {
  DEBUG_STAGE_MAP, DEBUG_VERDICT_MAP, NARRATION_TYPE_MAP, VISUAL_DESCRIPTION_KIND_MAP,
  evaluateSilencePrecondition, SILENCE_TRANSCRIPT_WINDOW_MS, SILENCE_SKIP_LABEL_MAP,
} from '../product/core-modules.mjs';
import { readLevelAt } from '../media/audio-levels.mjs';
import { AUDIO_SPEAK_THRESHOLD, NARRATION_ECHO_TAIL_MS, SILENCE_TICK_MS } from './renderer-constants.mjs';

// main.js 의 isNarrationEchoWindow(1727-1734)·100ms 침묵 tick(1736-1751)·handleSilenceTrigger(1753-1788).
export function createSilenceGlue({ ctx }) {
  const { clock, bridge, state, core } = ctx;
  let timer = null;

  function isNarrationEchoWindow() {
    const now = clock.nowPerf();
    if (core.narrator?.getSicState?.().isInserting) {
      state.narrationEchoUntil = now + NARRATION_ECHO_TAIL_MS;
      return true;
    }
    return now < state.narrationEchoUntil;
  }

  async function handleSilenceTrigger({ silenceMs }) {
    const sessionSeq = state.experimentSeq;
    const slideLabel = core.slideRegistry.currentLabel();
    const recentTranscript = core.transcriptWindow.getBefore({ nowTs: clock.nowPerf(), windowMs: SILENCE_TRANSCRIPT_WINDOW_MS });
    const wordBudget = ctx.buildWordBudget({ narrationType: NARRATION_TYPE_MAP.visualDescription, subKind: VISUAL_DESCRIPTION_KIND_MAP.reaction });
    const precondition = evaluateSilencePrecondition({ slideLabel, recentTranscript, wordBudget });
    const silenceLog = `무음 ${Math.round(silenceMs / 1000)}초 · 슬라이드=${slideLabel || '-'} · 모드=${ctx.mode}`;
    if (!precondition.isReady) {
      ctx.markDebug({ stage: DEBUG_STAGE_MAP.silence, verdict: DEBUG_VERDICT_MAP.skip, narrationType: NARRATION_TYPE_MAP.visualDescription, reason: SILENCE_SKIP_LABEL_MAP[precondition.reason], detail: silenceLog });
      return;
    }
    const buffer = await ctx.captureFrameJpeg({});
    // 캡처를 기다리는 사이 세션이 끝났으면 이전 세션의 무음이라 보내지 않는다.
    if (!state.isSessionActive || sessionSeq !== state.experimentSeq) return;
    if (!buffer) {
      ctx.markDebug({ stage: DEBUG_STAGE_MAP.silence, verdict: DEBUG_VERDICT_MAP.skip, narrationType: NARRATION_TYPE_MAP.visualDescription, reason: SILENCE_SKIP_LABEL_MAP.no_screen, detail: `${silenceLog} · 화면 캡처 실패` });
      return;
    }
    await bridge.invoke('pipeline-silence', {
      ts: clock.nowWall(), buffer: new Uint8Array(buffer), slideLabel, recentTranscript, silenceMs, wordBudget, eventVideoTimeMs: ctx.videoTimeMs(),
    });
  }

  // 레벨은 미리 계산한 100ms 목록에서 읽는다. 제품은 > 임계(초과)로 말소리를 센다.
  // 해설 재생 구간은 lastSpeechBlindAt 으로 말소리가 이어진 것으로 본다. 그래서 해설이 끝난 뒤부터 무음을 센다.
  function tick() {
    if (!state.isCaptureActive) return;
    if (isNarrationEchoWindow()) {
      state.lastSpeechBlindAt = clock.nowPerf();
      return;
    }
    const nowPerf = clock.nowPerf();
    if (readLevelAt({ levelList: ctx.levelList, timeMs: ctx.videoTimeMs() }) > AUDIO_SPEAK_THRESHOLD) state.lastAudioActiveAt = nowPerf;
    const lastHeardAt = Math.max(state.lastAudioActiveAt, state.lastSpeechBlindAt);
    if (core.silenceTrigger.update({ nowPerf, lastHeardAt, isSuspended: false })) {
      ctx.trackTask(handleSilenceTrigger({ silenceMs: nowPerf - lastHeardAt }), 'silence');
    }
  }

  return {
    // attemptStartExperiment(main.js:1894) 의 silenceTrigger.reset 과 100ms tick 시작.
    start() {
      core.silenceTrigger.reset({ nowPerf: clock.nowPerf() });
      timer = clock.setInterval(tick, SILENCE_TICK_MS);
    },
    stop() {
      if (timer !== null) clock.clearInterval(timer);
      timer = null;
    },
    tick, isNarrationEchoWindow, handleSilenceTrigger,
  };
}
