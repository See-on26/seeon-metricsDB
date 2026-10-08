// src/compare/compare-ad-distribution.mjs
import fs from 'node:fs';
import path from 'node:path';
import { AD_MATCH_TOLERANCE_MS, pairAdList, toCellText } from './compare-ad-timeline.mjs';
import { clusterRunAdList } from './ad-cluster.mjs';

// 실험실 결과 폴더에서 ad-timeline.json 옆에 있는 실행 정보(영상 파일 이름·재생기 영상 길이·완료 여부).
const LAB_RUN_INFO_FILE_NAME = 'run.json';
// 같은 영상인지 견줄 때 영상 길이 허용 차. 공장은 ffprobe 컨테이너 길이, 실험실은 재생기 video.duration 을 ms 로 반올림해
// 같은 파일이라도 조금 다를 수 있다.
export const VIDEO_DURATION_TOLERANCE_MS = 1000;

const toFileStem = (fileName) => path.basename(String(fileName), path.extname(String(fileName)));
const readFiniteOrNull = (value) => (Number.isFinite(value) ? value : null);

function readJsonFile({ filePath, label }) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} 읽지 못했다(${filePath}): ${error.message}`);
  }
}

// 공장 결과 하나. 영상은 결과 JSON 의 video(videoId·영상 파일·ffprobe 길이)로 안다.
function readFactoryInput(filePath) {
  const report = readJsonFile({ filePath, label: '공장 결과를' });
  const video = report?.video?.videoId ? {
    label: String(report.video.videoId), videoId: String(report.video.videoId),
    fileStem: report.video.file ? toFileStem(report.video.file) : null, durationMs: readFiniteOrNull(report.video.durationMs),
  } : null;
  return {
    filePath, video, isComplete: report?.isComplete !== false, adList: report?.adList || [], droppedList: report?.droppedList || [],
    warningList: video ? [] : [`공장 결과에 영상 정보(video.videoId)가 없어 같은 영상인지 보지 못했다: ${filePath}`],
  };
}

// 실험실 결과 하나. ad-timeline.json 에는 영상 정보가 없어 같은 폴더의 run.json(videoName·videoDurationMs·isComplete)으로 안다.
// run.json 이 없으면(파일만 옮긴 경우 등) 영상 확인 없이 쓰고 경고한다.
function readLabInput(filePath) {
  const timeline = readJsonFile({ filePath, label: '실험실 결과를' });
  const runInfoPath = path.join(path.dirname(filePath), LAB_RUN_INFO_FILE_NAME);
  const runInfo = fs.existsSync(runInfoPath) ? readJsonFile({ filePath: runInfoPath, label: `실험실 ${LAB_RUN_INFO_FILE_NAME} 을` }) : null;
  const video = runInfo?.videoName ? {
    label: String(runInfo.videoName), fileStem: toFileStem(runInfo.videoName), durationMs: readFiniteOrNull(runInfo.videoDurationMs),
  } : null;
  return {
    filePath, video, isComplete: runInfo?.isComplete !== false, adList: timeline?.adList || [], droppedList: timeline?.droppedList || [],
    warningList: video ? [] : [runInfo
      ? `실험실 ${LAB_RUN_INFO_FILE_NAME} 에 영상 이름(videoName)이 없어 같은 영상인지 보지 못했다: ${filePath}`
      : `실험실 ${LAB_RUN_INFO_FILE_NAME} 이 없어 같은 영상인지 보지 못했다: ${filePath}`],
  };
}

const isDurationClose = (left, right) => left === null || right === null || Math.abs(left - right) <= VIDEO_DURATION_TOLERANCE_MS;
const describeInput = (input) => `${input.filePath}(영상 ${input.video.label} · ${input.video.durationMs ?? '-'}ms)`;

function assertSameVideoPair({ base, other, isSameName }) {
  if (isSameName && isDurationClose(base.video.durationMs, other.video.durationMs)) return;
  throw new Error(`서로 다른 영상의 결과를 섞었다(영상 이름·길이 ±${VIDEO_DURATION_TOLERANCE_MS}ms 로 견줌): ${describeInput(base)} ↔ ${describeInput(other)}`);
}

// 같은 영상의 결과만 받았는지 본다. 영상 정보가 있는 결과끼리, 각 쪽의 첫 결과와 견준다.
// - 공장끼리: videoId 와 영상 길이. 실험실끼리: 영상 파일 이름과 길이.
// - 공장 ↔ 실험실: 실험실 영상 파일 이름(확장자 뺌)이 공장 videoId 나 공장 영상 파일 이름과 같고 길이가 같은지.
//   목록 JSON 으로 돌린 공장 결과는 videoId 가 파일 이름과 다를 수 있어 둘 중 하나만 같아도 된다.
function assertSameVideo({ factoryInputList, labInputList }) {
  const [factoryBase, ...factoryRestList] = factoryInputList.filter((input) => input.video);
  const [labBase, ...labRestList] = labInputList.filter((input) => input.video);
  for (const other of factoryRestList) assertSameVideoPair({ base: factoryBase, other, isSameName: other.video.videoId === factoryBase.video.videoId });
  for (const other of labRestList) assertSameVideoPair({ base: labBase, other, isSameName: other.video.fileStem === labBase.video.fileStem });
  if (factoryBase && labBase) {
    const isSameName = [factoryBase.video.videoId, factoryBase.video.fileStem].includes(labBase.video.fileStem);
    assertSameVideoPair({ base: factoryBase, other: labBase, isSameName });
  }
}

function toRunList({ inputList, sideLabel }) {
  const runList = inputList.filter((input) => input.isComplete)
    .map((input, index) => ({ runIndex: index + 1, filePath: input.filePath, adList: input.adList, droppedList: input.droppedList }));
  if (!runList.length) throw new Error(`${sideLabel} 쪽에 견줄 완료 결과가 없다(불완전한 결과는 뺀다)`);
  return runList;
}

// 분포 비교 입력: 공장 결과 JSON 들과 실험실 ad-timeline.json 들을 읽어 쪽마다 실행 목록(runIndex 는 불완전한 결과를 뺀 뒤 받은 순서로 1..)으로 만든다.
// 서로 다른 영상의 결과를 섞으면 오류로 멈춘다. 불완전한 결과(공장 isComplete=false, 실험실 run.json isComplete=false)는
// 반복 요약처럼 분포에서 빼고, 뺀 것과 영상을 확인하지 못한 것은 warningList 에 남긴다.
export function readDistributionInput({ factoryPathList, labPathList }) {
  const factoryInputList = factoryPathList.map(readFactoryInput);
  const labInputList = labPathList.map(readLabInput);
  assertSameVideo({ factoryInputList, labInputList });
  const warningList = [...factoryInputList, ...labInputList].flatMap((input) => [
    ...input.warningList, ...(input.isComplete ? [] : [`불완전한 결과(isComplete=false)라 뺀다: ${input.filePath}`]),
  ]);
  return {
    factoryRunList: toRunList({ inputList: factoryInputList, sideLabel: '공장' }),
    labRunList: toRunList({ inputList: labInputList, sideLabel: '실험실' }),
    warningList,
  };
}

// 버린 사유마다 실행별 수(실행 순서). 사유는 이름순.
function countDropReasonByRun({ factoryRunList, labRunList }) {
  const reasonList = [...new Set([...factoryRunList, ...labRunList].flatMap((run) => (run.droppedList || []).map((drop) => String(drop.reason))))].sort();
  const countByRun = (runList, reason) => runList.map((run) => (run.droppedList || []).filter((drop) => String(drop.reason) === reason).length);
  return Object.fromEntries(reasonList.map((reason) => [reason, { factory: countByRun(factoryRunList, reason), lab: countByRun(labRunList, reason) }]));
}

// 여러 번 돌린 공장과 실험실을 분포로 견준다. 쪽마다 실행들의 AD 를 반복 요약과 같은 규칙(clusterRunAdList)으로 묶은 뒤,
// 묶음을 재생 위치 중앙값을 위치로 삼아 실험실 비교의 짝 기준(pairAdList: 분류가 같고 ±toleranceMs 안, 가까운 것부터, 하나는 한 번만)으로 짝짓는다.
// rowList 는 짝(factory·lab 둘 다)과 한쪽에만 있는 묶음(다른 쪽 null)을 재생 위치 순(짝은 공장 중앙값, 위치 없는 묶음은 맨 뒤)으로 둔다.
// 등장 비율은 묶음의 hitRunCount / completedRunCount(그 쪽 실행 수)이고, 없는 쪽은 0 / 그 쪽 실행 수로 읽는다.
export function compareAdDistribution({ factoryRunList, labRunList, toleranceMs = AD_MATCH_TOLERANCE_MS }) {
  const factoryClusterList = clusterRunAdList({ runList: factoryRunList, toleranceMs });
  const labClusterList = clusterRunAdList({ runList: labRunList, toleranceMs });
  const toMatchItem = (cluster) => ({ type: cluster.type, playedMediaMs: cluster.playedMediaMs.median, cluster });
  const { pairList, leftOnlyList, rightOnlyList } = pairAdList({
    leftList: factoryClusterList.map(toMatchItem), rightList: labClusterList.map(toMatchItem), toleranceMs,
  });
  const readPosition = (row) => (row.factory ?? row.lab).playedMediaMs.median ?? Infinity;
  const rowList = [
    ...pairList.map(({ left, right }) => ({
      type: left.type, factory: left.cluster, lab: right.cluster, medianDiffMs: left.playedMediaMs - right.playedMediaMs,
    })),
    ...leftOnlyList.map(({ cluster }) => ({ type: cluster.type, factory: cluster, lab: null, medianDiffMs: null })),
    ...rightOnlyList.map(({ cluster }) => ({ type: cluster.type, factory: null, lab: cluster, medianDiffMs: null })),
  // 위치 없는 묶음끼리는 차가 NaN(Infinity - Infinity)이라 0 으로 두어 짝 → 공장에만 → 실험실에만 순서를 지킨다.
  ].sort((left, right) => (readPosition(left) - readPosition(right)) || 0);
  return {
    factoryRunCount: factoryRunList.length, labRunCount: labRunList.length,
    factoryAdCountList: factoryRunList.map((run) => run.adList.length), labAdCountList: labRunList.map((run) => run.adList.length),
    factoryClusterCount: factoryClusterList.length, labClusterCount: labClusterList.length, matchedCount: pairList.length,
    rowList, dropReasonCountMap: countDropReasonByRun({ factoryRunList, labRunList }),
  };
}

const formatMean = (countList) => String(Math.round((countList.reduce((sum, count) => sum + count, 0) / countList.length) * 10) / 10);
const formatCountList = (countList) => `${countList.join('·')}(평균 ${formatMean(countList)})`;
const formatHit = (cluster, runCount) => (cluster ? `${cluster.hitRunCount}/${cluster.completedRunCount}` : `0/${runCount}`);
const formatPlayed = (cluster) => {
  if (!cluster) return '-';
  const { median, min, max } = cluster.playedMediaMs;
  return median === null ? '위치 없음' : `${median}(${min}~${max})`;
};
const formatTextList = (cluster) => (cluster ? cluster.textList.map(toCellText).join(' / ') : '-');

export function formatDistributionMarkdown(result) {
  const factoryOnlyCount = result.rowList.filter((row) => !row.lab).length;
  const labOnlyCount = result.rowList.filter((row) => !row.factory).length;
  const lineList = [
    `- 실행 수: 공장 ${result.factoryRunCount} · 실험실 ${result.labRunCount}`,
    `- 실행별 AD 수: 공장 ${formatCountList(result.factoryAdCountList)} · 실험실 ${formatCountList(result.labAdCountList)}`,
    `- 묶음: 공장 ${result.factoryClusterCount} · 실험실 ${result.labClusterCount} · 짝 ${result.matchedCount} · 공장에만 ${factoryOnlyCount} · 실험실에만 ${labOnlyCount}`,
    `- 같은 쪽 실행끼리 같은 분류·재생 위치 ±${AD_MATCH_TOLERANCE_MS / 1000}초면 한 묶음, 두 쪽 묶음은 같은 분류·재생 위치 중앙값 ±${AD_MATCH_TOLERANCE_MS / 1000}초면 짝. 등장 = 그 묶음이 나온 실행 수 / 실행 수`,
    '', '| 유형 | 공장 등장 | 실험실 등장 | 공장 재생 위치 ms 중앙값(최소~최대) | 실험실 재생 위치 ms 중앙값(최소~최대) | 중앙값 차(ms) | 공장 문장 | 실험실 문장 |',
    '|---|---|---|---|---|---|---|---|',
    ...result.rowList.map((row) => `| ${row.type} | ${formatHit(row.factory, result.factoryRunCount)} | ${formatHit(row.lab, result.labRunCount)}`
      + ` | ${formatPlayed(row.factory)} | ${formatPlayed(row.lab)} | ${row.medianDiffMs ?? '-'} | ${formatTextList(row.factory)} | ${formatTextList(row.lab)} |`),
    '', '| 버린 사유 | 공장(실행별) | 실험실(실행별) |', '|---|---|---|',
    ...Object.entries(result.dropReasonCountMap).map(([reason, count]) => `| ${toCellText(reason)} | ${count.factory.join('·')} | ${count.lab.join('·')} |`),
  ];
  return `${lineList.join('\n')}\n`;
}
