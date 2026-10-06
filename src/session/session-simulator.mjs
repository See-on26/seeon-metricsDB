import path from 'node:path';
import {
  MODE_MAP, DEBUG_STAGE_MAP, DEBUG_VERDICT_MAP, NARRATION_QUEUE_TTL_MS, listDisabledNarrationClass, computeLookaheadMs, computeContextHoldMs,
} from '../product/core-modules.mjs';
import { POINTING_SAMPLE_MS } from './renderer-constants.mjs';
import { createSessionContext } from './session-context.mjs';
import { buildFeatureToggleStore } from './feature-preset.mjs';
import { createAsrGlue } from './asr-glue.mjs';
import { createDeixisGlue } from './deixis-glue.mjs';
import { createSilenceGlue } from './silence-glue.mjs';
import { createSlideGlue } from './slide-glue.mjs';
import { createOutputGlue } from './output-glue.mjs';
import { createFrameAccess, FRAME_IO_TIMEOUT_MS } from './frame-access.mjs';
import { startPlaybackChain } from './playback-chain.mjs';
import { createPlaybackRecorder, compactPieceList } from './playback-recorder.mjs';

const PROGRESS_INTERVAL_MS = 10000;
// 실험실 배수 규칙(lab drain-policy.js)과 같다: 영상 끝 + 모드 지연 + 대기 줄 TTL + 여유 15초까지 기다리고, 해설이 재생 중이면
// 그 해설이 끝나고 1초 뒤까지 늘린다. 실험실은 그 시각까지 늘 기다리지만, 공장은 남은 일이 없으면 바로 멈춘다(그 뒤로 바뀔 것이 없다).
const DRAIN_MARGIN_MS = 15000;
const DRAIN_TAIL_MS = 1000;
// 영상 끝 뒤 슬라이드 샘플을 마지막 격자 칸으로 두 번 더 한다. 히스토그램 게이트는 움직임 한 번 + 멈춤 한 번을 봐야 전환으로
// 확정하므로, 끝에서 바로 멈추면 마지막 칸에서 바뀐 화면을 놓친다. 실험실은 끝난 화면을 배수 동안 계속 샘플한다.
const END_FRAME_TICK_COUNT = 2;
const SESSION_START_LIMIT_MS = 30000;
const SESSION_END_LIMIT_MS = 30000;

// main.js:929-937 describeBeforeWindow
function describeBeforeWindow({ policy, anchorTs, nowPerf }) {
  const { beforeMs } = policy || {};
  if (Number.isFinite(anchorTs)) {
    const sinceSec = Math.round((nowPerf - anchorTs) / 1000);
    const capText = Number.isFinite(beforeMs) ? ` (상한 ${Math.round(beforeMs / 1000)}초)` : ' (상한 없음)';
    return `화면 전환 후 ${sinceSec}초${capText}`;
  }
  return `최근 ${Math.round((beforeMs ?? 60000) / 1000)}초`;
}

// main.js 의 attemptStartExperiment(1683-1788)·stopExperiment(1794-1848)·finalizeSession(1850-1866) 을 영상 하나의 세션으로 옮긴다.
// 회의 캡처 시작 = 영상 0ms, 영상 끝(D) 에서 캡처 쪽 감지를 멈추고, 지연 재생·생성 중인 해설이 빠질 때까지(배수) 돌린 뒤 정지한다.
export function createSessionSimulator({ clock, bridge, video, prep, options, workDir, log = console, onProgress = () => {} }) {
  const mediaDurationMs = video.probe.durationMs;
  const featureToggleStore = buildFeatureToggleStore({ isPageTransitionIncluded: options.isPageTransitionIncluded });
  let fatalError = null;
  const frameAccess = createFrameAccess({
    clock, frameReader: prep.frameReader, filePath: video.filePath, mediaDurationMs, ffmpegPath: options.ffmpegPath,
    timeoutMs: options.frameIoTimeoutMs ?? FRAME_IO_TIMEOUT_MS, log,
    onFatal: (error) => { fatalError ??= error; },
  });
  const ctx = createSessionContext({
    clock, bridge, mode: MODE_MAP.delayed, featureToggleStore, mediaDurationMs, levelList: prep.levelList, log,
    // 시각은 부른 순간의 영상 시각이다. 캡처 동안은 hold 로 가상 시간이 서 있다(canvas 캡처는 즉시).
    captureFrameJpeg: ({ normRect = null } = {}) => frameAccess.captureFrameJpeg({ timeMs: ctx.videoTimeMs(), normRect }),
  });
  const recorder = createPlaybackRecorder();
  const outputGlue = createOutputGlue({ ctx });
  const asrGlue = createAsrGlue({ ctx, segmentList: prep.segmentList, segmentBufferMap: prep.segmentBufferMap });
  createDeixisGlue({ ctx });
  const silenceGlue = createSilenceGlue({ ctx });
  // 제품 slides/ 폴더(paths 대역)와 섞이지 않게 이름을 나눈다.
  const slideGlue = createSlideGlue({ ctx, slideFrameDir: path.join(workDir, 'slides-frames'), readFrameAt: (timeMs) => frameAccess.readFrameAt(timeMs) });
  let playbackChain = null;
  let progressTimer = null;
  let startElapsedMs = null;
  let playingUntilElapsedMs = -Infinity;

  // main.js:1521-1526 onPipelineEvent
  bridge.onRendererEvent('pipeline-event', ({ payload, requestContext }) => {
    if (payload.type === 'asr') { asrGlue.handleAsrTranscript(payload); return; }
    if (payload.type === 'caption') outputGlue.handleCaptionEvent({ payload, requestContext });
  });

  // 배수 상한을 늘리려고 재생 중인 해설이 언제 끝나는지 기억한다.
  function handleAdStart(event) {
    playingUntilElapsedMs = Math.max(playingUntilElapsedMs, event.atElapsedMs + event.durationMs);
    outputGlue.noteAdStart(event);
  }

  // main 의 invoke 는 가상 타이머·파일 쓰기를 기다릴 수 있어 시계를 돌리며 기다린다.
  async function invokeUnderClock({ channel, payload, limitMs }) {
    let settled = null;
    bridge.invoke(channel, payload).then((result) => { settled = { result }; }, (error) => { settled = { error }; });
    await clock.runUntil({ isDone: () => settled !== null, deadlineElapsedMs: clock.elapsedMs() + limitMs });
    if (!settled) throw new Error(`${channel} 가 ${limitMs}ms 안에 끝나지 않았다`);
    if (settled.error) throw settled.error;
    return settled.result;
  }

  function reportProgress() {
    onProgress({
      videoTimeMs: Math.min(Math.round(ctx.videoTimeMs()), mediaDurationMs), durationMs: mediaDurationMs, adCount: outputGlue.getAdPlayList().length,
    });
  }

  function stopFrameCapture() {
    ctx.state.isCaptureActive = false;
    slideGlue.stop();
  }

  // 영상 끝(D): 침묵 감지를 멈추고(끝 뒤 소리는 없다) 지연 재생은 꼬리 모드로 남은 원음을 1배속으로 마저 튼다.
  // ASR 조각은 계획상 D 에서 끝난다. 슬라이드 샘플은 마지막 격자 칸으로 두 tick 더 본 뒤 멈춘다(isCaptureActive=false).
  function handleVideoEnd() {
    silenceGlue.stop();
    ctx.core.delaySource.enterTailMode();
    ctx.markDebug({
      stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.info, reason: '영상 끝 — 캡처 쪽 감지 멈춤',
      detail: `지연 재생·생성 중 해설은 배수까지 계속 · 슬라이드 샘플은 끝 화면으로 ${END_FRAME_TICK_COUNT}번 더`,
    });
    clock.setTimeout(stopFrameCapture, END_FRAME_TICK_COUNT * POINTING_SAMPLE_MS);
  }

  // 남은 일이 없으면 끝난다. 영상 끝 뒤 자리 예약은 지연 재생이 닿지 않으므로 기다리지 않는다.
  function isDrained() {
    const { core, state } = ctx;
    return !state.isCaptureActive
      && core.delayBuffer?.delayedVideo?.ended === true
      && ctx.getTaskCount() === 0
      && clock.inFlightCount === 0
      && !core.candidateScheduler.pending
      && !core.slideDwellGate.gate.isPending
      && core.narrationScheduler.pendingList.every((item) => item.captionCaptureMs > mediaDurationMs)
      && !core.narrator.currentEntry
      && core.narrator.queue.size === 0;
  }

  async function start() {
    const { state, policy } = ctx;
    // 꺼 둔 분류를 main 에 먼저 알린다(main.js:1176-1181, 1237).
    await invokeUnderClock({
      channel: 'pipeline-feature-toggles', payload: { disabledClassList: listDisabledNarrationClass({ store: featureToggleStore }) },
      limitMs: SESSION_START_LIMIT_MS,
    });
    // 제품은 세션 시작 실패를 무시하고 기록 없이 캡처하지만, 공장은 기록이 없으면 결과를 만들 수 없어 실패로 끝낸다.
    const sessionResult = await invokeUnderClock({
      channel: 'pipeline-session-start', payload: { mode: ctx.mode, asrLanguage: video.language }, limitMs: SESSION_START_LIMIT_MS,
    });
    if (!sessionResult?.sessionId) throw new Error(`제품 파이프라인 세션을 시작하지 못했다: ${sessionResult?.message || '세션 ID 없음'}`);
    state.currentSessionId = sessionResult.sessionId;
    state.recordPath = sessionResult.recordPath || null;
    state.lastScreenTransitionAt = clock.nowPerf();
    state.experimentSeq += 1;
    ctx.markDebug({
      stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.info, reason: '캡처 시작',
      detail: `모드=${ctx.mode} · 시작 시점 = 회의 시작 시점(0초)`
        + ` · 앞 맥락 ${describeBeforeWindow({ policy, anchorTs: state.lastScreenTransitionAt, nowPerf: clock.nowPerf() })}`
        + ` · 뒤 맥락 ${Math.round((policy?.afterMs ?? 0) / 1000)}초`
        + ` (ASR 청크 ${policy?.asrSegmentMs}ms(무음 절단 ${policy?.asrMinSegmentMs}ms 이후)`
        + ` + look-ahead ${computeLookaheadMs({ mode: ctx.mode })}ms + 보류 ${computeContextHoldMs({ mode: ctx.mode })}ms)`,
    });
    ctx.markSessionStart();
    startElapsedMs = clock.elapsedMs();
    state.isCaptureActive = true;
    state.isSessionActive = true;
    playbackChain = startPlaybackChain({ ctx, recorder, onAdStart: handleAdStart, onNarrationDrop: outputGlue.handleNarrationDrop });
    silenceGlue.start();
    slideGlue.start();
    asrGlue.start();
    clock.setTimeout(handleVideoEnd, mediaDurationMs);
    progressTimer = clock.setInterval(reportProgress, PROGRESS_INTERVAL_MS);
  }

  // 상한 사이에 해설이 새로 재생되기 시작하면 늘어난 상한까지 더 돈다(실험실은 500ms 마다 상한을 다시 잰다).
  async function drainAfterVideoEnd({ videoEndElapsedMs, drainLimitMs }) {
    const readDeadlineElapsedMs = () => Math.max(videoEndElapsedMs + drainLimitMs, playingUntilElapsedMs + DRAIN_TAIL_MS);
    for (;;) {
      const outcome = await clock.runUntil({ isDone: () => fatalError !== null || isDrained(), deadlineElapsedMs: readDeadlineElapsedMs() });
      if (outcome === 'done') return { isTimedOut: false };
      if (clock.elapsedMs() >= readDeadlineElapsedMs()) return { isTimedOut: true };
    }
  }

  function abortSession() {
    clock.clearInterval(progressTimer);
    ctx.state.isCaptureActive = false;
    ctx.state.isSessionActive = false;
    slideGlue.stop();
    silenceGlue.stop();
    playbackChain?.stop();
  }

  // main.js:1850-1866 finalizeSession. 제품처럼 정지 뒤 ASR 드레인을 main 이 가상 setTimeout 으로 기다리므로 시계를 돌리며 기다린다.
  async function endPipelineSession() {
    ctx.state.currentSessionId = null;
    let endResult = null;
    try {
      endResult = (await invokeUnderClock({ channel: 'pipeline-session-end', payload: undefined, limitMs: SESSION_END_LIMIT_MS })) ?? {};
    } catch (error) {
      log.warn(`[factory] 파이프라인 세션 종료 실패: ${error.message}`);
      return { isOk: false, message: error.message };
    }
    if (endResult.isOk) {
      ctx.markDebug({
        stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.info, reason: '세션 스냅샷 확정',
        detail: `${endResult.sessionId} · 발화 ${endResult.asrCount}건 · 슬라이드 ${endResult.slideMarkCount}건`,
      });
    }
    return endResult;
  }

  async function runToEnd() {
    const videoEndElapsedMs = startElapsedMs + mediaDurationMs;
    const drainLimitMs = ctx.policy.delayMs + NARRATION_QUEUE_TTL_MS + DRAIN_MARGIN_MS;
    const { isTimedOut } = await drainAfterVideoEnd({ videoEndElapsedMs, drainLimitMs });
    if (fatalError) {
      abortSession();
      throw fatalError;
    }
    if (isTimedOut) log.warn(`[factory] 배수 상한(영상 끝 + ${drainLimitMs}ms)에 닿아 멈춘다 — 남은 영상 안 해설은 drain_timeout 으로 기록`);
    const drainEndAfterVideoMs = Math.round(clock.elapsedMs() - videoEndElapsedMs);
    clock.clearInterval(progressTimer);
    // 재생 조각을 먼저 닫는다. 그 뒤 narrator.stop 이 알리는 정지는 조각표에 남지 않는다.
    recorder.close({ atElapsedMs: clock.elapsedMs(), mediaMs: ctx.core.delayBuffer.getDelayedTimeMs() });
    outputGlue.dropPendingAfterEnd({ isDrainTimedOut: isTimedOut });
    // stopExperiment 정리. 세션은 배수가 끝나야(연결 작업이 다 빠져야) 닫히고, 상한에 닿으면 실험실처럼 그 자리에서 닫힌다.
    stopFrameCapture();
    silenceGlue.stop();
    ctx.state.isSessionActive = false;
    ctx.core.candidateScheduler.reset();
    ctx.core.slideDwellGate.reset();
    playbackChain.stop();
    ctx.state.experimentSeq += 1;
    ctx.markDebug({ stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.info, reason: '회의 캡처 정지' });
    const endResult = await endPipelineSession();
    if (fatalError) throw fatalError;
    // runUntil 이 돌아와도 제품의 기록 파일 쓰기는 끝나지 않았을 수 있다. 결과를 읽기 전에 정착시킨다.
    await clock.settle();
    return {
      pieceList: compactPieceList(recorder.getPieceList()),
      captionRecordList: outputGlue.getCaptionRecordList(), dropRecordList: outputGlue.getDropRecordList(), adPlayList: outputGlue.getAdPlayList(),
      recordPath: ctx.state.recordPath, sessionStartWallMs: ctx.state.sessionStartWall,
      isDrainTimedOut: isTimedOut, drainLimitMs, drainEndAfterVideoMs, endResult,
      frameSourceError: ctx.state.frameSourceError ?? null, frameStats: frameAccess.getStats(),
    };
  }

  return { start, runToEnd, ctx };
}
