// src/compare/ad-cluster.mjs
import { AD_MATCH_TOLERANCE_MS, hasPlayedMs, measureAdMatchDiffMs } from './compare-ad-timeline.mjs';

// 묶음마다 남기는 서로 다른 문장 수. 같은 AD 라도 실행마다 문장이 달라질 수 있어 예시로만 남긴다.
const TEXT_SAMPLE_LIMIT = 3;

const compareText = (left, right) => {
  if (left === right) return 0;
  return left < right ? -1 : 1;
};

// 재생 위치 순으로 훑는다. 같은 시각이면 실행 순서 → 분류 → 문장 → 실행 안 순서로 정해, 실행 안 AD 순서가 달라도 결과가 같다.
function compareEntry(left, right) {
  return left.ad.playedMediaMs - right.ad.playedMediaMs
    || left.runOrder - right.runOrder
    || compareText(String(left.ad.type), String(right.ad.type))
    || compareText(String(left.ad.text ?? ''), String(right.ad.text ?? ''))
    || left.adOrder - right.adOrder;
}

function median(sortedList) {
  const middle = Math.floor(sortedList.length / 2);
  return sortedList.length % 2 ? sortedList[middle] : Math.round((sortedList[middle - 1] + sortedList[middle]) / 2);
}

function summarizeGroup({ group, runList }) {
  const playedList = group.memberList.map((member) => member.ad.playedMediaMs).filter(Number.isFinite).sort((left, right) => left - right);
  const textList = [...new Set(group.memberList.map((member) => String(member.ad.text ?? '')))].slice(0, TEXT_SAMPLE_LIMIT);
  const hitRunList = [...group.runOrderSet].sort((left, right) => left - right).map((runOrder) => runList[runOrder].runIndex);
  return {
    type: group.anchor.type, hitRunCount: hitRunList.length, completedRunCount: runList.length, hitRunList,
    playedMediaMs: playedList.length
      ? { median: median(playedList), min: playedList[0], max: playedList.at(-1) }
      : { median: null, min: null, max: null },
    textList,
  };
}

// 여러 실행(runList: [{ runIndex, adList }])의 AD 를 "같은 AD" 끼리 묶는다. 같은 AD 기준은 실험실 비교의 짝 기준(measureAdMatchDiffMs:
// 분류가 같고 재생 위치 playedMediaMs 가 ±toleranceMs 안)을 그대로 쓴다.
// 규칙(결정적): 모든 실행의 AD 를 재생 위치 순(compareEntry)으로 훑으며, 분류가 같고 묶음 첫 AD(가장 이른 AD)와 ±toleranceMs 안이고
// 그 실행의 AD 가 아직 없는 묶음 중 첫 AD 가 가장 가까운 것(같으면 먼저 생긴 것)에 넣고, 없으면 새 묶음을 연다.
// - 첫 AD 가 가장 이르므로 묶음 안 AD 는 [첫 AD, 첫 AD + toleranceMs] 에 있어 서로 모두 같은 AD 기준을 만족한다(사슬처럼 늘어나지 않는다).
// - 한 실행의 AD 는 한 묶음에 최대 하나다. 한 실행 안에서 가까운 같은 분류 AD 둘은 다른 묶음이 된다.
// - 재생 위치가 없는 AD 는 짝 기준을 만족할 수 없어 홀로 묶음이 되고 맨 뒤에(실행·실행 안 순서로) 둔다.
// 묶음은 재생 위치 중앙값 → 최솟값 → 생긴 순서로 정렬한다. hitRunList 는 그 AD 가 나온 실행의 runIndex, completedRunCount 는 받은 실행 수다.
export function clusterRunAdList({ runList, toleranceMs = AD_MATCH_TOLERANCE_MS }) {
  const entryList = runList.flatMap((run, runOrder) => run.adList.map((ad, adOrder) => ({ ad, runOrder, adOrder })));
  const groupList = [];
  for (const entry of entryList.filter((item) => hasPlayedMs(item.ad)).sort(compareEntry)) {
    let bestGroup = null;
    let bestDiffMs = Infinity;
    for (const group of groupList) {
      if (group.runOrderSet.has(entry.runOrder)) continue;
      const diffMs = measureAdMatchDiffMs({ left: group.anchor, right: entry.ad, toleranceMs });
      if (diffMs !== null && diffMs < bestDiffMs) { bestGroup = group; bestDiffMs = diffMs; }
    }
    if (!bestGroup) {
      bestGroup = { anchor: entry.ad, memberList: [], runOrderSet: new Set() };
      groupList.push(bestGroup);
    }
    bestGroup.memberList.push(entry);
    bestGroup.runOrderSet.add(entry.runOrder);
  }
  const timedClusterList = groupList
    .map((group, order) => ({ order, cluster: summarizeGroup({ group, runList }) }))
    .sort((left, right) => left.cluster.playedMediaMs.median - right.cluster.playedMediaMs.median
      || left.cluster.playedMediaMs.min - right.cluster.playedMediaMs.min
      || left.order - right.order)
    .map(({ cluster }) => cluster);
  const untimedClusterList = entryList.filter((item) => !hasPlayedMs(item.ad)).map((entry) => summarizeGroup({
    group: { anchor: entry.ad, memberList: [entry], runOrderSet: new Set([entry.runOrder]) }, runList,
  }));
  return [...timedClusterList, ...untimedClusterList];
}
