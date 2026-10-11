// src/product/core-modules.mjs
// 공장이 그대로 쓰는 제품 렌더러 코어 모듈. 경로는 서브모듈 seeon-meet 이다.
export {
  NARRATION_TYPE_MAP, NARRATION_CLASS_MAP, PAGE_TRANSITION_KIND_MAP, VISUAL_DESCRIPTION_KIND_MAP,
  DEBUG_STAGE_MAP, DEBUG_VERDICT_MAP, CROP_JPEG_QUALITY,
} from '../../seeon-meet/src/renderer/core/constants.js';
export {
  MODE_MAP, getModePolicy, computeWordBudget, computeLookaheadMs, computeSentenceWaitMs,
  computeContextHoldMs, resolveBeforeAnchorTs, getCatchupRateRange,
} from '../../seeon-meet/src/renderer/core/mode/mode-policy.js';
export {
  createFeatureToggleStore, listDisabledNarrationClass, FEATURE_KEY_MAP, FEATURE_TOGGLE_STORAGE_KEY,
} from '../../seeon-meet/src/renderer/core/mode/feature-toggle-store.js';
export { DelayBuffer, isCaptionDroppable, EXCESS_DROP_MS } from '../../seeon-meet/src/renderer/core/audio-renderer/delay-buffer.js';
export { NarrationScheduler } from '../../seeon-meet/src/renderer/core/audio-renderer/narration-scheduler.js';
export { GapCandidateStore, resolveGapSearchFromMs } from '../../seeon-meet/src/renderer/core/audio-renderer/gap-candidate-store.js';
export { GAP_CANDIDATE_SOURCE_MAP } from '../../seeon-meet/src/renderer/core/audio-renderer/audio-gap-candidates.js';
export {
  isImmediateCaption, isAnchoredCaption, NarrationHoldGate,
} from '../../seeon-meet/src/renderer/core/audio-renderer/narration-entry.js';
export {
  QUEUE_DROP_LABEL_MAP, QUEUE_DROP_REASON_MAP, NARRATION_QUEUE_TTL_MS,
} from '../../seeon-meet/src/renderer/core/audio-renderer/narration-queue.js';
export {
  NarrationAudioPrefetcher, narrationEntryKey, PREFETCH_AHEAD_COUNT,
} from '../../seeon-meet/src/renderer/core/audio-renderer/narration-audio-prefetcher.js';
export { CaptionNarrator } from '../../seeon-meet/src/renderer/core/audio-renderer/caption-narrator.js';
export {
  TransitionOrderGate, LEADER_STATUS_MAP, resolveFollowerInsertMs, PendingTransitionTracker, resolveAfterTransitionInsertMs,
} from '../../seeon-meet/src/renderer/core/audio-renderer/transition-order-gate.js';
export { isSegmentVoiced, isSegmentCutReady } from '../../seeon-meet/src/renderer/core/trigger/asr-segmenter.js';
export {
  UtteranceBoundaryDetector, classifyUtteranceEnding, buildSegmentBoundaryList,
} from '../../seeon-meet/src/renderer/core/trigger/utterance-boundary-detector.js';
export { TranscriptWindow } from '../../seeon-meet/src/renderer/core/trigger/transcript-window.js';
export { DeixisDetector } from '../../seeon-meet/src/renderer/core/trigger/deixis-detector.js';
export { resolveLastSpeechWallTs } from '../../seeon-meet/src/renderer/core/trigger/speech-activity.js';
export {
  SilenceTrigger, evaluateSilencePrecondition, SILENCE_TRANSCRIPT_WINDOW_MS, SILENCE_SKIP_LABEL_MAP,
} from '../../seeon-meet/src/renderer/core/trigger/silence-trigger.js';
export {
  DeixisCandidateScheduler, CANDIDATE_SOURCE_MAP, SUBMIT_RESULT_MAP,
} from '../../seeon-meet/src/renderer/core/trigger/deixis-candidate-scheduler.js';
export { judgeScreenDependency, SCREEN_DEPENDENCY_REASON_MAP } from '../../seeon-meet/src/renderer/core/trigger/screen-dependency.js';
export { PointingLocator, describeDirection } from '../../seeon-meet/src/renderer/core/trigger/pointing-locator.js';
export { SlideHistogramGate } from '../../seeon-meet/src/renderer/core/trigger/slide-histogram-gate.js';
export { SlideEmbeddingRegistry } from '../../seeon-meet/src/renderer/core/trigger/slide-embedding-registry.js';
export { SlideDwellGate, DWELL_STATE_MAP } from '../../seeon-meet/src/renderer/core/trigger/slide-dwell-gate.js';
export { computeGridEmbedding } from '../../seeon-meet/src/renderer/core/trigger/frame-embedding.js';
export { wallToVideoTimeMs, resolveSpeechEndWallTs } from '../../seeon-meet/src/renderer/core/capture/video-time.js';
export { fitWithinLongEdge, MAX_FRAME_LONG_EDGE_PX } from '../../seeon-meet/src/renderer/core/capture/frame-scale.js';
