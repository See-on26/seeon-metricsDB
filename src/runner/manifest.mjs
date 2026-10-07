// src/runner/manifest.mjs
import fs from 'node:fs';
import path from 'node:path';
import { buildOutputPathMap } from './output-paths.mjs';
import { listIdentityMismatch } from './result-identity.mjs';
import { formatWarningBrief } from './result-health.mjs';
import { REPEAT_SUMMARY_FILE_NAME, formatRepeatSummary } from './repeat-summary.mjs';

const MANIFEST_FILE_NAME = 'manifest.json';
const SUMMARY_FILE_NAME = 'summary.txt';
const pad2 = (value) => String(value).padStart(2, '0');

export function formatRunStamp(date) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

// JSON 은 mp3 합성 뒤 마지막에 쓰고 워커를 띄우기 전에 지우므로, 둘 다 있고 isComplete 면 끝난 결과다(아니면 missing·incomplete).
// 지금 작업(videoId·영상 파일·언어·전환 고지·반복 회차)과 identity(코드 버전·결과 설정)를 주면 AD 기록과 같을 때만 끝난 것(done)으로 친다.
// 다르면 mismatch 와 다른 곳을 문장 목록(mismatchList)으로 돌려준다. 같은 출력 이름이라도 다른 영상·코드·설정으로 만든 결과는 다시 돈다.
// 주지 않은 항목은 견주지 않는다. 반복 수(repeat.count)는 견주지 않아 --repeat 을 늘려도 이미 끝난 회차는 건너뛴다.
// 회차 기록(repeat)이 없는 이전 결과는 한 번만 돌린 결과라 1회차로 본다.
export function inspectVideoResult({ outDir, outStem, videoId, filePath, language, isPageTransitionIncluded, repeatIndex, identity }) {
  const { mp3Path, jsonPath } = buildOutputPathMap({ outDir, outStem });
  if (!fs.existsSync(mp3Path) || !fs.existsSync(jsonPath)) return { status: 'missing', mismatchList: [] };
  let report;
  try {
    report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch {
    return { status: 'incomplete', mismatchList: [] };
  }
  if (report?.isComplete !== true) return { status: 'incomplete', mismatchList: [] };
  const fieldList = [
    ['videoId', videoId, report.video?.videoId],
    ['영상 파일', filePath, report.video?.file],
    ['언어', language, report.video?.language],
    ['전환 고지', isPageTransitionIncluded === undefined ? undefined : Boolean(isPageTransitionIncluded), report.config?.isPageTransitionIncluded],
    ['반복 회차', repeatIndex, report.repeat?.index ?? 1],
  ];
  const mismatchList = fieldList
    .filter(([, expected, actual]) => expected !== undefined && expected !== actual)
    .map(([label, expected, actual]) => `${label} ${actual} → ${expected}`);
  if (identity) mismatchList.push(...listIdentityMismatch({ identity, report }));
  return { status: mismatchList.length ? 'mismatch' : 'done', mismatchList };
}

export function isVideoDone(option) {
  return inspectVideoResult(option).status === 'done';
}

// 임시 파일에 다 쓴 뒤 이름을 바꿔, 쓰는 도중 죽어도 반쯤 쓴 파일이 남지 않게 한다.
function writeFileAtomic({ filePath, text }) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, text);
  fs.renameSync(tempPath, filePath);
}

// 실행 기록(manifest.json·summary.txt)을 쓴다. 영상 하나가 끝날 때마다 불러 중간에 죽어도 기록이 남는다.
// 반복 요약(--repeat N 실행이 끝날 때)을 주면 repeat-summary.json 도 쓰고 summary.txt 끝에 영상별 반복 줄을 더한다.
export function writeRunRecord({ outDir, manifest, repeatSummary = null }) {
  writeFileAtomic({ filePath: path.join(outDir, MANIFEST_FILE_NAME), text: JSON.stringify(manifest, null, 2) });
  if (repeatSummary) writeFileAtomic({ filePath: path.join(outDir, REPEAT_SUMMARY_FILE_NAME), text: JSON.stringify(repeatSummary, null, 2) });
  writeFileAtomic({ filePath: path.join(outDir, SUMMARY_FILE_NAME), text: formatSummary(manifest, repeatSummary) });
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
// seeonMeet·factory·resultConfig 는 이번 실행이 견준 코드 버전·결과 설정이다(건너뛴 영상도 이와 같을 때만 건너뛴다).
export function buildManifest({
  previousManifest, runOptions, seeonMeet, factory = null, resultConfig = null, jobList, resultList, skippedJobList, startedAt, endedAt, interruptedBy = null,
}) {
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
    seeonMeet, ...(factory ? { factory } : {}), ...(resultConfig ? { resultConfig } : {}),
    runOptions, startedAt, endedAt, ...(interruptedBy ? { interruptedBy } : {}), videoList,
    counts: {
      total: videoList.length,
      done: videoList.filter((video) => video.status === 'done').length,
      failed: videoList.filter((video) => video.status === 'failed').length,
      skipped: skippedJobList.length,
    },
  };
}

// 터미널·summary 에서 작업을 가리키는 이름. --repeat N(N > 1)의 작업은 같은 영상의 몇 번째 회차인지 붙인다(a r2/3).
export function formatJobLabel(job) {
  return job.repeatCount > 1 ? `${job.videoId} r${job.repeatIndex}/${job.repeatCount}` : job.videoId;
}

// 완료 영상 중 경고(부하로 생긴 시간 초과·판정 대체 등)가 있는 것은 수와 ⚠ 로 드러낸다. 자세한 내용은 영상 JSON 의 warningList 에 있다.
// --repeat N(N > 1)이면 수는 작업(영상 × 회차) 단위라 머리줄에 작업 수와 영상 수 × 반복 수를 적고, 반복 요약을 주면 끝에 영상별 반복 줄을 붙인다.
export function formatSummary(manifest, repeatSummary = null) {
  const remainingCount = manifest.counts.total - manifest.counts.done - manifest.counts.failed;
  const warnedCount = manifest.videoList.filter((video) => video.status === 'done' && video.warningList?.length).length;
  const repeatCount = manifest.runOptions?.repeatCount ?? 1;
  const totalText = repeatCount > 1
    ? `작업 ${manifest.counts.total}(영상 ${manifest.counts.total / repeatCount} × 반복 ${repeatCount})`
    : `영상 ${manifest.counts.total}`;
  const lineList = [
    `seeon-meet ${manifest.seeonMeet?.commit || '-'}${manifest.seeonMeet?.isDirty ? ' (수정됨)' : ''}`
      + ` · 공장 ${manifest.factory?.commit || '-'}${manifest.factory?.isDirty ? ' (수정됨)' : ''}`,
    `${totalText} · 완료 ${manifest.counts.done}${warnedCount ? `(경고 ${warnedCount})` : ''} · 실패 ${manifest.counts.failed}`
      + ` · 건너뜀 ${manifest.counts.skipped}${remainingCount > 0 ? ` · 남음 ${remainingCount}` : ''}`,
    `시작 ${manifest.startedAt} · 끝 ${manifest.endedAt || '진행 중'}${manifest.interruptedBy ? ` · ${manifest.interruptedBy} 로 중단` : ''}`,
  ];
  for (const video of manifest.videoList) {
    if (video.status === 'failed') lineList.push(`  ✖ ${formatJobLabel(video)}: ${video.errorMessage}`);
    else if (video.status === 'done') {
      const warningText = formatWarningBrief(video.warningList);
      lineList.push(`  ✔ ${formatJobLabel(video)}: AD ${video.adCount ?? '-'}개${video.isSkipped ? ' (이전 실행)' : ''}${warningText ? ` ${warningText}` : ''}`);
    }
  }
  return `${lineList.join('\n')}\n${repeatSummary ? formatRepeatSummary(repeatSummary) : ''}`;
}
