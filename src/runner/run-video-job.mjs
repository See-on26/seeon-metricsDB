import fs from 'node:fs';
import path from 'node:path';
import { MODE_MAP, getModePolicy } from '../product/core-modules.mjs';
import { bootProductPipeline } from '../product/boot-pipeline.mjs';
import { getJudgeSourceCountMap } from '../product/product-loader.mjs';
import { readVersionMap, buildResultConfig } from './result-identity.mjs';
import { createVirtualClock } from '../clock/virtual-clock.mjs';
import { resolveFfmpegPaths } from '../media/ffmpeg.mjs';
import { probeVideo } from '../media/probe.mjs';
import { decodeMeterLevelList } from '../media/audio-levels.mjs';
import { planAsrSegmentList } from '../media/asr-segment-plan.mjs';
import { encodeVoicedSegmentList } from '../media/segment-encoder.mjs';
import { openSampleFrameReader } from '../media/frame-source.mjs';
import { createSessionSimulator } from '../session/session-simulator.mjs';
import { EVAL_PRESET_MAP } from '../session/feature-preset.mjs';
import { renderOutputMp3 } from '../output/render-mp3.mjs';
import { buildAdReport, readPipelineRecordList } from '../output/ad-report.mjs';
import { buildOutputPathMap } from './output-paths.mjs';
import { buildIncompleteReasonList, buildWarningList, describeIncompleteReason } from './result-health.mjs';

// 영상 하나: 준비(ffprobe·레벨·조각·프레임 스트림) → 세션(가상 시계) → AD wav 저장 → mp3 합성 → JSON(마지막에 써서 완료 표시).
// 기반 문제(화면 입력 실패·서비스 장애·세션 종료 실패)로 불완전한 결과는 mp3·JSON(isComplete=false, 사유) 을 남긴 뒤 실패로 던진다.
// 다시 돌리면 그 영상을 다시 처리한다. 부하로 생기는 품질 저하(시간 초과·판정 대체 등)는 완료로 두고 warningList 에 남긴다.
// runConcurrency 는 이번 실행의 동시 수로, 결과 JSON 에 남긴다.
export async function runVideoJob({ job, outDir, runConcurrency = null, onProgress = () => {}, log = console, openFrameReader = openSampleFrameReader }) {
  const realStartedAt = performance.now();
  // 실제로 돈 코드 버전을 시작할 때 읽는다. 긴 처리 중에 체크아웃이 바뀌어도 이 영상은 시작 때 읽은 코드로 돈다.
  const versionMap = readVersionMap();
  const { ffmpegPath, ffprobePath } = resolveFfmpegPaths({ env: process.env });
  const pathMap = buildOutputPathMap({ outDir, outStem: job.outStem });
  await fs.promises.mkdir(pathMap.adDir, { recursive: true });
  const probe = await probeVideo({ filePath: job.filePath, ffprobePath });
  // 워커 풀이 영상 길이로 시간 상한을 잡도록 긴 준비 단계 전에 길이를 먼저 알린다.
  onProgress({ videoTimeMs: 0, durationMs: probe.durationMs, adCount: 0 });
  const policy = getModePolicy({ mode: MODE_MAP.delayed });
  const levelList = await decodeMeterLevelList({ filePath: job.filePath, probe, ffmpegPath });
  const segmentList = planAsrSegmentList({ levelList, durationMs: probe.durationMs, segmentMs: policy.asrSegmentMs, minSegmentMs: policy.asrMinSegmentMs });
  const segmentBufferMap = probe.hasAudio ? await encodeVoicedSegmentList({ filePath: job.filePath, segmentList, channelCount: probe.audioChannelCount, ffmpegPath }) : new Map();
  log.log(`[factory] ${job.videoId} 준비 끝 — 길이 ${probe.durationMs}ms · ASR 조각 ${segmentBufferMap.size}개 · 언어 ${job.language}`);

  const frameReader = openFrameReader({ filePath: job.filePath, ffmpegPath });
  const clock = createVirtualClock({ startWallMs: Date.now() });
  let sessionResult = null;
  let scopedFetch = null;
  let pipelineConfig = null;
  let bridge = null;
  try {
    const pipeline = bootProductPipeline({ outDir: pathMap.workDir, clock, log });
    ({ scopedFetch, pipelineConfig, bridge } = pipeline);
    const simulator = createSessionSimulator({
      clock, bridge: pipeline.bridge, video: { ...job, probe }, prep: { levelList, segmentList, segmentBufferMap, frameReader },
      options: { isPageTransitionIncluded: Boolean(job.isPageTransitionIncluded), ffmpegPath }, workDir: pathMap.workDir, log, onProgress,
    });
    await simulator.start();
    sessionResult = await simulator.runToEnd();
  } finally {
    frameReader.close();
  }
  if (!sessionResult.pieceList.length) throw new Error('재생 타임라인이 비었다 — 지연 재생이 시작되지 않았다');

  const recordBySeq = new Map(sessionResult.captionRecordList.map((record) => [record.captionSeq, record]));
  const adPathByRef = new Map();
  const adFileByRef = new Map();
  for (const [index, adPlay] of sessionResult.adPlayList.entries()) {
    const record = recordBySeq.get(adPlay.captionSeq);
    if (!record?.wavBytes) continue;
    const wavPath = path.join(pathMap.adDir, `ad-${String(index + 1).padStart(3, '0')}.wav`);
    await fs.promises.writeFile(wavPath, record.wavBytes);
    adPathByRef.set(adPlay.captionSeq, wavPath);
    adFileByRef.set(adPlay.captionSeq, path.relative(outDir, wavPath));
  }
  const { durationMs: renderedDurationMs } = await renderOutputMp3({
    sourcePath: job.filePath, hasSourceAudio: probe.hasAudio, pieceList: sessionResult.pieceList, adPathByRef,
    outPath: pathMap.mp3Path, workDir: pathMap.workDir, sampleRate: probe.audioSampleRate, channelCount: probe.audioChannelCount, ffmpegPath,
  });
  const processingMs = performance.now() - realStartedAt;
  const callLog = scopedFetch.getCallLog();
  const judgeSourceCountMap = getJudgeSourceCountMap();
  const swallowedErrorCountMap = { task: sessionResult.swallowedErrorCountMap, ipc: bridge.getSwallowedErrorCountMap() };
  // 토큰은 JSON 에 남기지 않는다.
  const { bedrockApiKey, ...modelConfig } = pipelineConfig;
  const report = buildAdReport({
    video: { videoId: job.videoId, file: job.filePath, durationMs: probe.durationMs, width: probe.width, height: probe.height, language: job.language },
    seeonMeet: versionMap.seeonMeet,
    // resultConfig 는 재실행 때 건너뛸지 견주는 결과 설정, runConcurrency 는 이번 실행의 동시 수다.
    config: {
      mode: MODE_MAP.delayed, isEvalPreset: true, isPageTransitionIncluded: Boolean(job.isPageTransitionIncluded),
      featureToggleMap: { ...EVAL_PRESET_MAP, page_transition: Boolean(job.isPageTransitionIncluded) }, modelConfig,
      resultConfig: buildResultConfig({ pipelineConfig }), runConcurrency,
    },
    sessionStartWallMs: sessionResult.sessionStartWallMs, pieceList: sessionResult.pieceList,
    captionRecordList: sessionResult.captionRecordList, adPlayList: sessionResult.adPlayList, dropRecordList: sessionResult.dropRecordList,
    pipelineRecordList: readPipelineRecordList({ recordPath: sessionResult.recordPath }), callLog,
    judgeSourceCountMap,
    adFileByRef, outputFileName: path.basename(pathMap.mp3Path), renderedDurationMs, processingMs,
  });
  const incompleteReasonList = buildIncompleteReasonList({ sessionResult, callLog });
  const warningList = buildWarningList({
    callLog, judgeSourceCountMap, judgeBackend: pipelineConfig.judgeBackend, sessionResult, swallowedErrorCountMap, incompleteReasonList,
  });
  // 공장 버전은 제품 버전 바로 뒤에 둔다(재실행 때 건너뛸지 견주는 값).
  const finalReport = {
    schemaVersion: report.schemaVersion, isComplete: report.isComplete, video: report.video, seeonMeet: report.seeonMeet, factory: versionMap.factory,
    ...report,
    isComplete: incompleteReasonList.length === 0,
    // swallowedErrorCountMap: 연결 코드가 제품처럼 삼킨 오류 수(task: 비동기 작업 이름별, ipc: IPC 채널별). 0 이 아니면 연결 코드 버그를 의심한다.
    stats: {
      ...report.stats, frame: { sourceError: sessionResult.frameSourceError, ...sessionResult.frameStats },
      swallowedErrorCountMap,
    },
    incompleteReasonList, warningList,
    session: {
      isDrainTimedOut: sessionResult.isDrainTimedOut, drainLimitMs: sessionResult.drainLimitMs, drainEndAfterVideoMs: sessionResult.drainEndAfterVideoMs,
      appendedTailMs: sessionResult.appendedTailMs, remainingTaskCount: sessionResult.remainingTaskCount, inFlightCallCount: sessionResult.inFlightCallCount,
      recordFile: sessionResult.recordPath ? path.relative(outDir, sessionResult.recordPath) : null, endResult: sessionResult.endResult,
    },
  };
  // mp3 를 다 쓴 뒤 JSON 을 마지막에 쓴다. 재실행은 JSON 의 isComplete 로 끝난 영상을 건너뛴다.
  await fs.promises.writeFile(pathMap.jsonPath, JSON.stringify(finalReport, null, 2));
  if (incompleteReasonList.length) {
    throw new Error(`결과가 불완전하다 — ${incompleteReasonList.map(describeIncompleteReason).join(' · ')} (mp3·JSON 은 남겼고 JSON 은 isComplete=false)`);
  }
  return {
    videoId: job.videoId, outStem: job.outStem, status: 'done', durationMs: probe.durationMs, processingMs: Math.round(processingMs),
    adCount: finalReport.adList.length, droppedCount: finalReport.droppedList.length, warningList,
    outputPathMap: { mp3: path.basename(pathMap.mp3Path), json: path.basename(pathMap.jsonPath) },
  };
}
