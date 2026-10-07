// src/runner/repeat-summary.mjs
import fs from 'node:fs';
import { buildOutputPathMap } from './output-paths.mjs';
import { AD_MATCH_TOLERANCE_MS } from '../compare/compare-ad-timeline.mjs';
import { clusterRunAdList } from '../compare/ad-cluster.mjs';

export const REPEAT_SUMMARY_FILE_NAME = 'repeat-summary.json';
const NOT_RUN_REASON = '돌지 않았다(중단 등으로 띄우지 않음)';

// 끝났다고 기록된 회차의 결과 JSON 을 읽는다. 못 읽거나 불완전하면 그 사유를 돌려줘 실패한 회차로 센다.
function readCompletedReport({ outDir, outStem }) {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(buildOutputPathMap({ outDir, outStem }).jsonPath, 'utf8'));
  } catch (error) {
    return { reason: `결과 JSON 을 읽지 못했다: ${error.message}` };
  }
  if (report?.isComplete !== true) return { reason: '결과가 불완전하다(isComplete=false)' };
  return { report };
}

const sortKeyList = (map) => Object.fromEntries(Object.entries(map).sort(([left], [right]) => (left < right ? -1 : Number(left > right))));

function countBy(itemList, readKey) {
  const countMap = {};
  for (const item of itemList) {
    const key = String(readKey(item));
    countMap[key] = (countMap[key] || 0) + 1;
  }
  return sortKeyList(countMap);
}

// 실행별 AD 수(완료 회차 순)와 평균(소수 둘째 자리)·최소·최대. 완료가 없으면 수치는 null.
function summarizeAdCount(countList) {
  if (!countList.length) return { countList, mean: null, min: null, max: null };
  const mean = countList.reduce((sum, count) => sum + count, 0) / countList.length;
  return { countList, mean: Math.round(mean * 100) / 100, min: Math.min(...countList), max: Math.max(...countList) };
}

// 영상 하나의 회차 기록(manifest 작업 줄)으로 요약을 만든다. 수치는 완료 회차만으로 내고, 목록은 모두 completedRunList 순서다.
function summarizeVideo({ outDir, videoList }) {
  const [first] = videoList;
  const completedList = [];
  const failedRunList = [];
  for (const video of [...videoList].sort((left, right) => left.repeatIndex - right.repeatIndex)) {
    if (video.status === 'failed') { failedRunList.push({ repeatIndex: video.repeatIndex, reason: video.errorMessage }); continue; }
    if (video.status !== 'done') { failedRunList.push({ repeatIndex: video.repeatIndex, reason: NOT_RUN_REASON }); continue; }
    const { report, reason } = readCompletedReport({ outDir, outStem: video.outStem });
    if (reason) failedRunList.push({ repeatIndex: video.repeatIndex, reason });
    else completedList.push({ repeatIndex: video.repeatIndex, adList: report.adList || [], droppedList: report.droppedList || [] });
  }
  const classCountMapList = completedList.map((run) => countBy(run.adList, (ad) => ad.type));
  const classList = [...new Set(classCountMapList.flatMap((countMap) => Object.keys(countMap)))].sort();
  return {
    videoId: first.videoId, outStem: first.videoOutStem, filePath: first.filePath, runCount: first.repeatCount,
    completedRunList: completedList.map((run) => run.repeatIndex), failedRunList,
    adCount: summarizeAdCount(completedList.map((run) => run.adList.length)),
    adCountByClass: Object.fromEntries(classList.map((type) => [type, classCountMapList.map((countMap) => countMap[type] || 0)])),
    droppedReasonCountList: completedList.map((run) => countBy(run.droppedList, (drop) => drop.reason)),
    clusterList: clusterRunAdList({ runList: completedList.map((run) => ({ runIndex: run.repeatIndex, adList: run.adList })) }),
  };
}

// --repeat N(N > 1) 실행의 반복 요약(repeat-summary.json). manifest 의 작업 기록을 영상(videoOutStem)별로 모아,
// 완료 회차의 결과 JSON 으로 AD 수·분류별 수·버린 사유 수와 AD 묶음(clusterRunAdList, 같은 분류·재생 위치 ±2초)을 낸다.
// 실패·불완전·돌지 않은 회차는 수치에서 빼고 failedRunList 에 사유와 함께 남긴다. 중단된 실행이면 끝난 회차까지로 낸다.
export function buildRepeatSummary({ outDir, manifest }) {
  const videoListByStem = new Map();
  for (const video of manifest.videoList) {
    if (!video.repeatIndex) continue;
    if (!videoListByStem.has(video.videoOutStem)) videoListByStem.set(video.videoOutStem, []);
    videoListByStem.get(video.videoOutStem).push(video);
  }
  return {
    repeatCount: manifest.runOptions?.repeatCount ?? 1, matchToleranceMs: AD_MATCH_TOLERANCE_MS,
    startedAt: manifest.startedAt, endedAt: manifest.endedAt, ...(manifest.interruptedBy ? { interruptedBy: manifest.interruptedBy } : {}),
    videoList: [...videoListByStem.values()].map((videoList) => summarizeVideo({ outDir, videoList })),
  };
}

const formatMean = (value) => String(Math.round(value * 10) / 10);

// summary.txt 끝에 붙일 영상별 한 줄. "늘 나온 AD" 는 완료 회차 모두에 나온 묶음, "가끔 나온 AD" 는 그보다 적게 나온 묶음이다.
export function formatRepeatSummary(repeatSummary) {
  const lineList = [`반복 요약(같은 분류·재생 위치 ±${AD_MATCH_TOLERANCE_MS / 1000}초면 같은 AD, 자세히는 ${REPEAT_SUMMARY_FILE_NAME})`];
  for (const video of repeatSummary.videoList) {
    const head = `  ${video.videoId}: 반복 ${video.runCount}회(완료 ${video.completedRunList.length})`;
    if (!video.completedRunList.length) { lineList.push(`${head}: 완료 결과 없음`); continue; }
    const alwaysCount = video.clusterList.filter((cluster) => cluster.hitRunCount === cluster.completedRunCount).length;
    const { mean, min, max } = video.adCount;
    lineList.push(`${head}: AD 평균 ${formatMean(mean)}(${min}~${max}) · 늘 나온 AD ${alwaysCount} · 가끔 나온 AD ${video.clusterList.length - alwaysCount}`);
  }
  return `${lineList.join('\n')}\n`;
}
