import {
  NARRATION_TYPE_MAP, getModePolicy, computeWordBudget, computeLookaheadMs, computeSentenceWaitMs,
  TranscriptWindow, GapCandidateStore, UtteranceBoundaryDetector, SilenceTrigger, PointingLocator, SlideHistogramGate,
  SlideEmbeddingRegistry, TransitionOrderGate, DeixisCandidateScheduler, DeixisDetector, SlideDwellGate,
  resolveLastSpeechWallTs, describeDirection,
} from '../product/core-modules.mjs';
import { POINTING_LOCATOR_OPTION_MAP } from './renderer-constants.mjs';

// main.js:231 ROUTABLE_TYPE_LIST
const ROUTABLE_TYPE_LIST = [NARRATION_TYPE_MAP.deixis, NARRATION_TYPE_MAP.interpretation, NARRATION_TYPE_MAP.visualDescription];

// main.js 의 모듈 상태(70-121·502-555·835-881)를 영상 하나 동안 쓰는 한 객체로 모은다.
export function createSessionContext({ clock, bridge, mode, featureToggleStore, mediaDurationMs, levelList, captureFrameJpeg, log = console }) {
  const policy = getModePolicy({ mode });
  // 코어 클래스는 반드시 가상 시계를 주입받는다. 기본값(전역 setTimeout·performance.now)이 남으면 판단이 실제 시계로 돈다.
  const timeoutDeps = { setTimer: (fn, ms) => clock.setTimeout(fn, ms), clearTimer: (handle) => clock.clearTimeout(handle) };
  const intervalDeps = { setTimer: (fn, ms) => clock.setInterval(fn, ms), clearTimer: (handle) => clock.clearInterval(handle) };
  const noop = () => {};
  const hooks = { onDeixis: noop, onDeixisDecision: noop, onDwellSatisfied: noop, onDwellCancelled: noop };
  const state = {
    sessionStartPerf: null, sessionStartWall: null, isCaptureActive: false, isSessionActive: false, experimentSeq: 0,
    lastAudioActiveAt: 0, lastSpeechBlindAt: 0, narrationEchoUntil: 0, lastDeixisDecidedAt: -Infinity,
    lastScreenTransitionAt: null, isConfirmingSlide: false, hasWarnedLocalEmbedding: false,
    lastPointingMotionAt: -Infinity, lastAnnotationSnapshotAt: -Infinity, lastScreenNarration: '',
    slideEventVideoTimeMap: new Map(), slideTransitionWallTsMap: new Map(), currentSessionId: null, recordPath: null,
  };
  let taskCount = 0;

  // main.js:859-864 getLastSpeechWallTs
  function getLastSpeechWallTs() {
    return resolveLastSpeechWallTs({
      lastActiveAt: state.lastAudioActiveAt, lastBlindAt: state.lastSpeechBlindAt, nowPerf: clock.nowPerf(), nowWall: clock.nowWall(),
    });
  }

  const core = {
    transcriptWindow: new TranscriptWindow({}),
    gapCandidateStore: new GapCandidateStore({}),
    boundaryDetector: new UtteranceBoundaryDetector({ onBoundary: noop }),
    silenceTrigger: new SilenceTrigger(),
    pointingLocator: new PointingLocator(POINTING_LOCATOR_OPTION_MAP),
    histogramGate: new SlideHistogramGate({}),
    slideRegistry: new SlideEmbeddingRegistry({}),
    transitionOrderGate: new TransitionOrderGate(),
    candidateScheduler: new DeixisCandidateScheduler({
      onDecide: (decision) => hooks.onDeixisDecision(decision), getLastSpeechWallTs, ...timeoutDeps,
    }),
    deixisDetector: new DeixisDetector({ onDeixis: (event) => hooks.onDeixis(event) }),
    slideDwellGate: new SlideDwellGate({
      onSatisfied: (event) => hooks.onDwellSatisfied(event), onCancelled: (event) => hooks.onDwellCancelled(event), ...timeoutDeps,
    }),
    delaySource: null, delayBuffer: null, narrationScheduler: null, narrator: null, narrationGate: null,
  };
  // attemptStartExperiment(main.js:1704-1708) 의 모드별 lookahead·문장 대기.
  core.candidateScheduler.setLookaheadMs({ lookaheadMs: computeLookaheadMs({ mode }) });
  core.candidateScheduler.setSentenceWaitMs({ sentenceWaitMs: computeSentenceWaitMs({ mode }) });

  const ctx = {
    clock, bridge, mode, policy, state, core, hooks, featureToggleStore, mediaDurationMs, levelList, captureFrameJpeg, log,
    timeoutDeps, intervalDeps,
    // 제품의 captureSource.startedAtMs(meet-capture-session.js:44). 이 순간이 영상 0ms 다.
    markSessionStart() {
      state.sessionStartPerf = clock.nowPerf();
      state.sessionStartWall = clock.nowWall();
    },
    videoTimeMs: () => (state.sessionStartPerf === null ? 0 : clock.nowPerf() - state.sessionStartPerf),
    toWallTs: (videoMs) => state.sessionStartWall + videoMs,
    // main.js:123-125 markDebug. 같은 문구로 pipeline.jsonl 에 남겨 실험실 기록과 견줄 수 있게 한다.
    markDebug({ stage, verdict, reason, detail = '', narrationType = null }) {
      bridge.send('pipeline-debug', { stage, verdict, reason, detail, narrationType, ts: clock.nowWall() });
    },
    // 제품은 끝을 기다리지 않는 비동기 작업(.catch(() => {}))이다. 공장은 배수 판정에 쓰려고 센다.
    trackTask(promise, label) {
      taskCount += 1;
      Promise.resolve(promise)
        .catch((error) => log.warn(`[factory] ${label} 실패(무시): ${error.message}`))
        .finally(() => { taskCount -= 1; });
    },
    getTaskCount: () => taskCount,
    // main.js:227-241 buildWordBudget·buildWordBudgetMap. 제품처럼 currentDelayMs 는 0 으로 둔다.
    buildWordBudget: ({ narrationType, subKind = null }) => computeWordBudget({ mode, narrationType, subKind, currentDelayMs: 0 }),
    buildWordBudgetMap() {
      const budgetMap = {};
      for (const narrationType of ROUTABLE_TYPE_LIST) budgetMap[narrationType] = ctx.buildWordBudget({ narrationType });
      return budgetMap;
    },
    getLastSpeechWallTs,
    // main.js:561-567 getPointingSequence
    getPointingSequence() {
      const sequence = core.pointingLocator.locateSequence({ nowTs: clock.nowPerf() });
      const pointingOrderHint = sequence.events.length >= 2
        ? sequence.events.map((event, index) => `${index + 1}) ${describeDirection(event.centroid)}`).join(', ')
        : '';
      return { region: sequence.hasRegion ? sequence.unionRect : null, pointingOrderHint };
    },
    // main.js:925-927 waitFor
    waitVirtual: (ms) => new Promise((resolve) => { clock.setTimeout(resolve, ms); }),
  };
  return ctx;
}
