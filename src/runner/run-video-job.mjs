import fs from 'node:fs';
import path from 'node:path';
import { MODE_MAP, getModePolicy } from '../product/core-modules.mjs';
import { bootProductPipeline } from '../product/boot-pipeline.mjs';
import { readSeeonMeetVersion } from '../product/product-version.mjs';
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

export const INCOMPLETE_REASON_MAP = { frameSourceError: 'frame_source_error', frameCaptureFailed: 'frame_capture_failed' };

// 공장 쪽 화면 입력이 실패하면 제품이 했을 판정(슬라이드·포인팅·지시 화면)이 빠져 실험실과 견줄 수 없다. 그런 결과는 완료로 치지 않는다.
export function buildIncompleteReasonList({ sessionResult }) {
  const reasonList = [];
  const { frameSourceError, frameStats } = sessionResult;
  if (frameSourceError) {
    reasonList.push({ code: INCOMPLETE_REASON_MAP.frameSourceError, message: frameSourceError.message, videoTimeMs: frameSourceError.videoTimeMs });
  }
  if (frameStats?.captureFailCount > 0) reasonList.push({ code: INCOMPLETE_REASON_MAP.frameCaptureFailed, count: frameStats.captureFailCount });
  return reasonList;
}

function describeIncompleteReason(reason) {
  if (reason.code === INCOMPLETE_REASON_MAP.frameSourceError) return `프레임 읽기 실패(${Math.round(reason.videoTimeMs)}ms): ${reason.message}`;
  return `JPEG 캡처 실패 ${reason.count}건`;
}

// 영상 하나: 준비(ffprobe·레벨·조각·프레임 스트림) → 세션(가상 시계) → AD wav 저장 → mp3 합성 → JSON(마지막에 써서 완료 표시).
// 화면 입력이 실패한 결과는 mp3·JSON(isComplete=false, 사유) 을 남긴 뒤 실패로 던진다. 다시 돌리면 그 영상을 다시 처리한다.
export async function runVideoJob({ job, outDir, onProgress = () => {}, log = console, openFrameReader = openSampleFrameReader }) {
  const realStartedAt = performance.now();
  const { ffmpegPath, ffprobePath } = resolveFfmpegPaths({ env: process.env });
  const pathMap = buildOutputPathMap({ outDir, outStem: job.outStem });
  await fs.promises.mkdir(pathMap.adDir, { recursive: true });
  const probe = await probeVideo({ filePath: job.filePath, ffprobePath });
  // 워커 풀이 영상 길이로 시간 상한을 잡도록 긴 준비 단계 전에 길이를 먼저 알린다.
  onProgress({ videoTimeMs: 0, durationMs: probe.durationMs, adCount: 0 });
  const policy = getModePolicy({ mode: MODE_MAP.delayed });
  const levelList = await decodeMeterLevelList({ filePath: job.filePath, probe, ffmpegPath });
  const segmentList = planAsrSegmentList({ levelList, durationMs: probe.durationMs, segmentMs: policy.asrSegmentMs, minSegmentMs: policy.asrMinSegmentMs });
  const segmentBufferMap = probe.hasAudio ? await encodeVoicedSegmentList({ filePath: job.filePath, segmentList, ffmpegPath }) : new Map();
  log.log(`[factory] ${job.videoId} 준비 끝 — 길이 ${probe.durationMs}ms · ASR 조각 ${segmentBufferMap.size}개 · 언어 ${job.language}`);

  const frameReader = openFrameReader({ filePath: job.filePath, ffmpegPath });
  const clock = createVirtualClock({ startWallMs: Date.now() });
  let sessionResult = null;
  let scopedFetch = null;
  let pipelineConfig = null;
  try {
    const pipeline = bootProductPipeline({ outDir: pathMap.workDir, clock, log });
    ({ scopedFetch, pipelineConfig } = pipeline);
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
  // 토큰은 JSON 에 남기지 않는다.
  const { bedrockApiKey, ...modelConfig } = pipelineConfig;
  const report = buildAdReport({
    video: { videoId: job.videoId, file: job.filePath, durationMs: probe.durationMs, width: probe.width, height: probe.height, language: job.language },
    seeonMeet: readSeeonMeetVersion(),
    config: {
      mode: MODE_MAP.delayed, isEvalPreset: true, isPageTransitionIncluded: Boolean(job.isPageTransitionIncluded),
      featureToggleMap: { ...EVAL_PRESET_MAP, page_transition: Boolean(job.isPageTransitionIncluded) }, modelConfig,
    },
    sessionStartWallMs: sessionResult.sessionStartWallMs, pieceList: sessionResult.pieceList,
    captionRecordList: sessionResult.captionRecordList, adPlayList: sessionResult.adPlayList, dropRecordList: sessionResult.dropRecordList,
    pipelineRecordList: readPipelineRecordList({ recordPath: sessionResult.recordPath }), callLog: scopedFetch.getCallLog(),
    adFileByRef, outputFileName: path.basename(pathMap.mp3Path), renderedDurationMs, processingMs,
  });
  const incompleteReasonList = buildIncompleteReasonList({ sessionResult });
  const finalReport = {
    ...report,
    isComplete: incompleteReasonList.length === 0,
    stats: { ...report.stats, frame: { sourceError: sessionResult.frameSourceError, ...sessionResult.frameStats } },
    incompleteReasonList,
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
    adCount: finalReport.adList.length, droppedCount: finalReport.droppedList.length,
    outputPathMap: { mp3: path.basename(pathMap.mp3Path), json: path.basename(pathMap.jsonPath) },
  };
}
