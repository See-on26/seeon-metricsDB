// src/runner/manifest.mjs
import fs from 'node:fs';
import path from 'node:path';
import { buildOutputPathMap } from './output-paths.mjs';

const MANIFEST_FILE_NAME = 'manifest.json';
const pad2 = (value) => String(value).padStart(2, '0');

export function formatRunStamp(date) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

// JSON 은 mp3 합성 뒤 마지막에 쓰므로, 둘 다 있고 isComplete 면 끝난 영상이다.
export function isVideoDone({ outDir, outStem }) {
  const { mp3Path, jsonPath } = buildOutputPathMap({ outDir, outStem });
  if (!fs.existsSync(mp3Path) || !fs.existsSync(jsonPath)) return false;
  try {
    return JSON.parse(fs.readFileSync(jsonPath, 'utf8')).isComplete === true;
  } catch {
    return false;
  }
}

export function readManifest({ outDir }) {
  const manifestPath = path.join(outDir, MANIFEST_FILE_NAME);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`이전 실행의 ${MANIFEST_FILE_NAME} 을 읽지 못했다(${manifestPath}): ${error.message}`);
  }
}

export function buildManifest({ previousManifest, runOptions, seeonMeet, jobList, resultList, skippedJobList, startedAt, endedAt }) {
  const previousMap = new Map((previousManifest?.videoList || []).map((video) => [video.outStem, video]));
  const resultMap = new Map(resultList.map((result) => [result.outStem, result]));
  const skippedSet = new Set(skippedJobList.map((job) => job.outStem));
  const videoList = jobList.map((job) => {
    if (resultMap.has(job.outStem)) return { ...job, ...resultMap.get(job.outStem) };
    if (skippedSet.has(job.outStem)) return { ...job, ...(previousMap.get(job.outStem) || {}), status: 'done', isSkipped: true };
    return { ...job, status: 'not_run' };
  });
  return {
    seeonMeet, runOptions, startedAt, endedAt, videoList,
    counts: {
      total: videoList.length,
      done: videoList.filter((video) => video.status === 'done').length,
      failed: videoList.filter((video) => video.status === 'failed').length,
      skipped: skippedJobList.length,
    },
  };
}

export function formatSummary(manifest) {
  const lineList = [
    `seeon-meet ${manifest.seeonMeet?.commit || '-'}${manifest.seeonMeet?.isDirty ? ' (수정됨)' : ''}`,
    `영상 ${manifest.counts.total} · 완료 ${manifest.counts.done} · 실패 ${manifest.counts.failed} · 건너뜀 ${manifest.counts.skipped}`,
    `시작 ${manifest.startedAt} · 끝 ${manifest.endedAt}`,
  ];
  for (const video of manifest.videoList) {
    if (video.status === 'failed') lineList.push(`  ✖ ${video.videoId}: ${video.errorMessage}`);
    else if (video.status === 'done') lineList.push(`  ✔ ${video.videoId}: AD ${video.adCount ?? '-'}개${video.isSkipped ? ' (이전 실행)' : ''}`);
  }
  return `${lineList.join('\n')}\n`;
}
