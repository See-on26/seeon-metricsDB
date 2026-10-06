// src/runner/manifest.mjs
import fs from 'node:fs';
import path from 'node:path';
import { buildOutputPathMap } from './output-paths.mjs';

const MANIFEST_FILE_NAME = 'manifest.json';
const SUMMARY_FILE_NAME = 'summary.txt';
const pad2 = (value) => String(value).padStart(2, '0');

export function formatRunStamp(date) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

// JSON 은 mp3 합성 뒤 마지막에 쓰고 워커를 띄우기 전에 지우므로, 둘 다 있고 isComplete 면 끝난 영상이다.
// 지금 작업(videoId·영상 파일·언어·전환 고지)을 주면 AD 기록의 video·config 와 같을 때만 끝난 것으로 친다 — 같은 출력 이름이라도 다른 영상·설정으로 만든 결과는 다시 돈다.
export function isVideoDone({ outDir, outStem, videoId, filePath, language, isPageTransitionIncluded }) {
  const { mp3Path, jsonPath } = buildOutputPathMap({ outDir, outStem });
  if (!fs.existsSync(mp3Path) || !fs.existsSync(jsonPath)) return false;
  let report;
  try {
    report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch {
    return false;
  }
  if (report?.isComplete !== true) return false;
  const pairList = [
    [videoId, report.video?.videoId],
    [filePath, report.video?.file],
    [language, report.video?.language],
    [isPageTransitionIncluded === undefined ? undefined : Boolean(isPageTransitionIncluded), report.config?.isPageTransitionIncluded],
  ];
  return pairList.every(([expected, actual]) => expected === undefined || expected === actual);
}

// 임시 파일에 다 쓴 뒤 이름을 바꿔, 쓰는 도중 죽어도 반쯤 쓴 파일이 남지 않게 한다.
function writeFileAtomic({ filePath, text }) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, text);
  fs.renameSync(tempPath, filePath);
}

// 실행 기록(manifest.json·summary.txt)을 쓴다. 영상 하나가 끝날 때마다 불러 중간에 죽어도 기록이 남는다.
export function writeRunRecord({ outDir, manifest }) {
  writeFileAtomic({ filePath: path.join(outDir, MANIFEST_FILE_NAME), text: JSON.stringify(manifest, null, 2) });
  writeFileAtomic({ filePath: path.join(outDir, SUMMARY_FILE_NAME), text: formatSummary(manifest) });
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

// resultList 에 없는 영상은 not_run(아직 돌지 않았거나 중단으로 띄우지 않음). endedAt 이 null 이면 실행 중 기록이다.
export function buildManifest({ previousManifest, runOptions, seeonMeet, jobList, resultList, skippedJobList, startedAt, endedAt, interruptedBy = null }) {
  const previousMap = new Map((previousManifest?.videoList || []).map((video) => [video.outStem, video]));
  const resultMap = new Map(resultList.map((result) => [result.outStem, result]));
  const skippedSet = new Set(skippedJobList.map((job) => job.outStem));
  const videoList = jobList.map((job) => {
    if (resultMap.has(job.outStem)) return { ...job, ...resultMap.get(job.outStem) };
    if (skippedSet.has(job.outStem)) {
      // 이전 실행의 끝난 기록(AD 수 등)만 잇는다. 실패 기록의 이유가 끝난 영상에 섞이지 않게.
      const previous = previousMap.get(job.outStem);
      return { ...job, ...(previous?.status === 'done' ? previous : {}), status: 'done', isSkipped: true };
    }
    return { ...job, status: 'not_run' };
  });
  return {
    seeonMeet, runOptions, startedAt, endedAt, ...(interruptedBy ? { interruptedBy } : {}), videoList,
    counts: {
      total: videoList.length,
      done: videoList.filter((video) => video.status === 'done').length,
      failed: videoList.filter((video) => video.status === 'failed').length,
      skipped: skippedJobList.length,
    },
  };
}

export function formatSummary(manifest) {
  const remainingCount = manifest.counts.total - manifest.counts.done - manifest.counts.failed;
  const lineList = [
    `seeon-meet ${manifest.seeonMeet?.commit || '-'}${manifest.seeonMeet?.isDirty ? ' (수정됨)' : ''}`,
    `영상 ${manifest.counts.total} · 완료 ${manifest.counts.done} · 실패 ${manifest.counts.failed} · 건너뜀 ${manifest.counts.skipped}${remainingCount > 0 ? ` · 남음 ${remainingCount}` : ''}`,
    `시작 ${manifest.startedAt} · 끝 ${manifest.endedAt || '진행 중'}${manifest.interruptedBy ? ` · ${manifest.interruptedBy} 로 중단` : ''}`,
  ];
  for (const video of manifest.videoList) {
    if (video.status === 'failed') lineList.push(`  ✖ ${video.videoId}: ${video.errorMessage}`);
    else if (video.status === 'done') lineList.push(`  ✔ ${video.videoId}: AD ${video.adCount ?? '-'}개${video.isSkipped ? ' (이전 실행)' : ''}`);
  }
  return `${lineList.join('\n')}\n`;
}
