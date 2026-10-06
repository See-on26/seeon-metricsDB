import fs from 'node:fs';
import path from 'node:path';
import {
  DEBUG_STAGE_MAP, DEBUG_VERDICT_MAP, NARRATION_TYPE_MAP, PAGE_TRANSITION_KIND_MAP, computeGridEmbedding,
} from '../product/core-modules.mjs';
import {
  POINTING_SAMPLE_MS, POINTING_MOTION_DEBOUNCE_MS, LOCAL_EMBED_MATCH_THRESHOLD, ANNOTATION_SNAPSHOT_MIN_INTERVAL_MS,
} from './renderer-constants.mjs';

const LOCAL_EMBEDDING_WARNING = '[slide] GPU 임베딩 서버 미연결 — 로컬 그리드 임베딩으로 폴백(정확도 낮음, 고지는 유지)';

// main.js 의 slideDwellGate 콜백(528-549)·samplePointingFrame(625-643)·detectSlideTransition(645-661)·
// confirmSlideCandidate(663-708)·requestPageTransitionNarration(710-745)·attachPointingMotion(886-899)·
// saveSlideFrameWithMark(902-909)·saveAnnotationSnapshot(911-923).
// 균형 모드는 선판정(isSpeculative)이 없어 체류를 채운 뒤에만 전환 고지를 만든다(main.js:539, 707).
export function createSlideGlue({ ctx, readFrameAt, slideFrameDir }) {
  const { clock, bridge, state, core } = ctx;
  const { dwellMs } = core.slideDwellGate;
  let samplerTimer = null;
  let samplingChain = Promise.resolve();

  // src/main/ipc.js:80-89(save-slide-frame) 와 같은 폴더 규칙이다. base 프레임은 슬라이드마다 한 번만 쓴다.
  async function saveSlideFrame({ slideLabel, frameKind, buffer }) {
    const slideDirName = `slide-${String(slideLabel).split('-')[0]}`;
    const dirPath = state.currentSessionId
      ? path.join(slideFrameDir, state.currentSessionId, slideDirName)
      : path.join(slideFrameDir, slideDirName);
    await fs.promises.mkdir(dirPath, { recursive: true });
    const isBase = frameKind === 'base';
    const filePath = path.join(dirPath, isBase ? 'base.jpg' : 'annotation.jpg');
    if (isBase && fs.existsSync(filePath)) return filePath;
    await fs.promises.writeFile(filePath, buffer);
    return filePath;
  }

  // transitionTs 는 슬라이드가 실제로 바뀐 시각이다. 체류 확정 뒤에 저장하므로 ts 보다 이르다.
  async function saveSlideFrameWithMark({ slideLabel, frameKind, buffer, transitionTs = null }) {
    const ts = clock.nowWall();
    const filePath = await saveSlideFrame({ slideLabel, frameKind, buffer });
    bridge.send('pipeline-slide-mark', { ts, slideLabel, frameKind, filePath, transitionTs });
  }

  async function requestPageTransitionNarration({ label, isRevisit }) {
    const buffer = await ctx.captureFrameJpeg({});
    if (!buffer) return;
    const ts = clock.nowWall();
    ctx.trackTask(saveSlideFrameWithMark({
      slideLabel: label, frameKind: 'base', buffer, transitionTs: state.slideTransitionWallTsMap.get(label) ?? null,
    }), 'slide-frame');
    const wordBudget = ctx.buildWordBudget({ narrationType: NARRATION_TYPE_MAP.pageTransition, subKind: PAGE_TRANSITION_KIND_MAP.slide });
    if (wordBudget.isDroppable) {
      ctx.markDebug({
        stage: DEBUG_STAGE_MAP.budget, verdict: DEBUG_VERDICT_MAP.skip, narrationType: NARRATION_TYPE_MAP.pageTransition,
        reason: '어절 예산이 유형 하한 미달 → 드롭', detail: `슬라이드 ${label} 모드=${ctx.mode} 하한=${wordBudget.minWordCount}어절`,
      });
      return;
    }
    // 평가 프리셋에서도 생성은 한다(제품과 같은 GPU 부하). 출력은 main 의 기능 게이트가 막는다.
    await bridge.invoke('pipeline-frame', {
      ts, buffer: new Uint8Array(buffer), slideLabel: label, wordBudget, isRevisit: Boolean(isRevisit),
      eventVideoTimeMs: state.slideEventVideoTimeMap.get(label) ?? ctx.videoTimeMs(),
    }).catch(() => null);
  }

  async function confirmSlideCandidate({ isFirst, imageData }) {
    const buffer = await ctx.captureFrameJpeg({});
    const remote = buffer ? await bridge.invoke('embed-frame', { buffer: new Uint8Array(buffer) }).catch(() => null) : null;
    const isRemoteEmbedding = Boolean(remote?.isOk && Array.isArray(remote.embedding));
    const embedding = isRemoteEmbedding ? remote.embedding : computeGridEmbedding(imageData);
    if (!isRemoteEmbedding && !state.hasWarnedLocalEmbedding) {
      state.hasWarnedLocalEmbedding = true;
      ctx.log.warn(LOCAL_EMBEDDING_WARNING);
    }
    const decision = core.slideRegistry.handleCandidate(isRemoteEmbedding
      ? { embedding }
      : { embedding, matchThreshold: LOCAL_EMBED_MATCH_THRESHOLD });
    const distance = decision.distance.toFixed(3);
    const source = isRemoteEmbedding ? 'gpu' : 'local';
    if (decision.isSameSlide) {
      ctx.markDebug({
        stage: DEBUG_STAGE_MAP.slide, verdict: DEBUG_VERDICT_MAP.skip, narrationType: NARRATION_TYPE_MAP.pageTransition,
        reason: '동일 슬라이드 — 전환 아님', detail: `슬라이드 ${decision.label} 거리=${distance} 임베딩=${source}`,
      });
      return;
    }
    if (!decision.isNew && !decision.isRevisit) return;
    const isRevisit = Boolean(decision.isRevisit);
    if (decision.isNew && buffer) {
      ctx.trackTask(bridge.invoke('pipeline-slide-text', { slideLabel: decision.label, buffer: new Uint8Array(buffer) }), 'slide-text');
    }
    // 사건 영상 시각은 임베딩 응답을 받은 뒤의 시각이다(제품과 같음).
    state.lastScreenTransitionAt = clock.nowPerf();
    state.slideEventVideoTimeMap.set(decision.label, ctx.videoTimeMs());
    state.slideTransitionWallTsMap.set(decision.label, clock.nowWall());
    ctx.markDebug({
      stage: DEBUG_STAGE_MAP.slide, verdict: DEBUG_VERDICT_MAP.info, narrationType: NARRATION_TYPE_MAP.pageTransition,
      reason: `${isRevisit ? '재방문' : (isFirst ? '첫' : '새')} 슬라이드 확정`,
      detail: `슬라이드 ${decision.label} 거리=${distance} 임베딩=${source} → 체류 ${dwellMs}ms 후판정(확정 후 생성)`,
    });
    core.slideDwellGate.enter({ label: decision.label, isRevisit });
  }

  // ROI 가 전체 프레임으로 고정이라 ROI 세대 리셋·변경 억제(main.js:609-623, 654)는 없다.
  function detectSlideTransition({ imageData, ts }) {
    const verdict = core.histogramGate.sample({ imageData, ts });
    if (!verdict.isTransition && !verdict.isFirst) return;
    if (state.isConfirmingSlide) return;
    state.isConfirmingSlide = true;
    ctx.trackTask(confirmSlideCandidate({ isFirst: verdict.isFirst, imageData }).finally(() => { state.isConfirmingSlide = false; }), 'slide-confirm');
  }

  // saveAnnotationSnapshot 의 동기 부분(레지스트리 필기 번호·간격 기준 시각)만 따른다. 필기 이미지는 AD 에 영향이 없어 저장하지 않는다.
  function noteAnnotation() {
    const annotation = core.slideRegistry.handleAnnotation();
    if (!annotation) return;
    const now = clock.nowPerf();
    if (now - state.lastAnnotationSnapshotAt < ANNOTATION_SNAPSHOT_MIN_INTERVAL_MS) return;
    state.lastAnnotationSnapshotAt = now;
  }

  function attachPointingMotion() {
    const now = clock.nowPerf();
    const motion = core.pointingLocator.locate({ nowTs: now });
    if (!motion.hasRegion) return;
    if (now - state.lastPointingMotionAt < POINTING_MOTION_DEBOUNCE_MS) return;
    state.lastPointingMotionAt = now;
    const { region, pointingOrderHint } = ctx.getPointingSequence();
    noteAnnotation();
    const isAttached = core.candidateScheduler.attachPointing({ region: region || motion.rect, pointingOrderHint });
    ctx.log.log(`[deixis] 포인팅 모션 changedRatio=${(motion.changedRatio ?? 0).toFixed(3)}`
      + ` → ${isAttached ? '대기 중인 발화 후보에 영역 첨부' : '대기 후보 없음 (포인터는 트리거가 아니다)'}`);
  }

  // 제품은 그 순간 화면에 보이는 프레임을 동기로 읽는다. 공장은 같은 순간의 시각·영상 시각을 잡아 두고 그 시각 프레임을 읽는다.
  async function sampleFrame() {
    if (!state.isCaptureActive) return;
    const ts = clock.nowPerf();
    const imageData = await readFrameAt(ctx.videoTimeMs());
    if (!imageData) return;
    core.pointingLocator.sample({ imageData, ts });
    detectSlideTransition({ imageData, ts });
    attachPointingMotion();
  }

  ctx.hooks.onDwellSatisfied = ({ label, isRevisit }) => {
    ctx.markDebug({
      stage: DEBUG_STAGE_MAP.slide, verdict: DEBUG_VERDICT_MAP.pass, narrationType: NARRATION_TYPE_MAP.pageTransition,
      reason: `체류 확정 (${dwellMs}ms)`, detail: `슬라이드 ${label}${isRevisit ? ' 재방문' : ''} · 지금 고지 생성`,
    });
    ctx.trackTask(requestPageTransitionNarration({ label, isRevisit }), 'page-transition');
  };
  ctx.hooks.onDwellCancelled = ({ label, isRevisit }) => {
    ctx.markDebug({
      stage: DEBUG_STAGE_MAP.slide, verdict: DEBUG_VERDICT_MAP.skip, narrationType: NARRATION_TYPE_MAP.pageTransition,
      reason: `체류 미달 (${dwellMs}ms 못 채움)`,
      detail: `슬라이드 ${label}${isRevisit ? ' 재방문' : ''} — 스쳐 지나간 화면은 고지하지 않는다(§5.4)`,
    });
  };

  return {
    // 제품 setInterval(samplePointingFrame, 400) 과 같다(main.js:1759). 프레임 리더는 시각이 줄지 않는 차례 읽기만 받으므로
    // 앞 샘플이 끝난 뒤 다음 샘플을 잇는다.
    start() {
      samplerTimer = clock.setInterval(() => {
        samplingChain = samplingChain.then(sampleFrame).catch((error) => ctx.log.warn(`[slide] 프레임 샘플 실패(무시): ${error.message}`));
        ctx.trackTask(samplingChain, 'frame-sample');
      }, POINTING_SAMPLE_MS);
    },
    stop() {
      if (samplerTimer !== null) clock.clearInterval(samplerTimer);
      samplerTimer = null;
    },
    sampleFrame, detectSlideTransition, confirmSlideCandidate, requestPageTransitionNarration, attachPointingMotion,
  };
}
