// LLM 은 결정적이지 않아 완전 일치는 기대하지 않는다(spec §7). 유형이 같고 삽입(재생) 위치가 ±toleranceMs 안이면 같은 AD 로 본다.
// 위치는 playedMediaMs 로 잰다. 실험실 outputMs 는 녹음 앞 무음을 포함해 공장 출력 시각과 기준이 다르다.
// 재생 위치가 없는 AD(실험실에서 재생 시각을 못 구한 경우)는 짝을 짓지 않고 한쪽에만 남긴다. null 을 0 으로 계산하면 영상 앞쪽 AD 와 잘못 짝지어진다.
// 이 기준(AD_MATCH_TOLERANCE_MS·measureAdMatchDiffMs·pairAdList)은 여러 실행의 AD 묶기(ad-cluster.mjs)·분포 비교도 같이 쓴다.
export const AD_MATCH_TOLERANCE_MS = 2000;
export const hasPlayedMs = (ad) => Number.isFinite(ad.playedMediaMs);

// 두 AD 가 같은 AD 인지: 분류(type)가 같고 둘 다 재생 위치가 있으며 그 차가 toleranceMs 안(경계 포함)이면 차의 절댓값, 아니면 null.
export function measureAdMatchDiffMs({ left, right, toleranceMs = AD_MATCH_TOLERANCE_MS }) {
  if (left.type !== right.type || !hasPlayedMs(left) || !hasPlayedMs(right)) return null;
  const diffMs = Math.abs(left.playedMediaMs - right.playedMediaMs);
  return diffMs <= toleranceMs ? diffMs : null;
}

// 왼쪽 AD 를 재생 위치 순(위치 없는 것은 뒤)으로 훑으며 아직 짝이 없는 오른쪽 AD 중 같은 AD 이고 가장 가까운 것(같으면 앞의 것)과 짝짓는다.
// 오른쪽 AD 하나는 한 번만 쓴다. 짝은 훑은 순서, 남은 왼쪽도 훑은 순서, 남은 오른쪽은 받은 순서다.
export function pairAdList({ leftList, rightList, toleranceMs = AD_MATCH_TOLERANCE_MS }) {
  const rightRemainList = [...rightList];
  const pairList = [];
  const leftOnlyList = [];
  const sortedLeftList = [
    ...leftList.filter(hasPlayedMs).sort((left, right) => left.playedMediaMs - right.playedMediaMs),
    ...leftList.filter((ad) => !hasPlayedMs(ad)),
  ];
  for (const left of sortedLeftList) {
    let bestIndex = -1;
    let bestDiffMs = Infinity;
    rightRemainList.forEach((right, index) => {
      const diffMs = measureAdMatchDiffMs({ left, right, toleranceMs });
      if (diffMs !== null && diffMs < bestDiffMs) { bestIndex = index; bestDiffMs = diffMs; }
    });
    if (bestIndex < 0) { leftOnlyList.push(left); continue; }
    const [right] = rightRemainList.splice(bestIndex, 1);
    pairList.push({ left, right });
  }
  return { pairList, leftOnlyList, rightOnlyList: rightRemainList };
}

export function compareAdTimeline({ factoryReport, labTimeline, toleranceMs = AD_MATCH_TOLERANCE_MS }) {
  const { pairList, leftOnlyList: factoryOnlyList, rightOnlyList: labRemainList } = pairAdList({
    leftList: factoryReport.adList, rightList: labTimeline.adList, toleranceMs,
  });
  const matchedList = pairList.map(({ left: factoryAd, right: labAd }) => {
    const hasEventMs = Number.isFinite(factoryAd.eventMediaMs) && Number.isFinite(labAd.eventMediaMs);
    return {
      type: factoryAd.type, factoryText: factoryAd.text, labText: labAd.text,
      playedDiffMs: factoryAd.playedMediaMs - labAd.playedMediaMs,
      eventDiffMs: hasEventMs ? factoryAd.eventMediaMs - labAd.eventMediaMs : null,
    };
  });
  const dropReasonCountMap = {};
  const countDrop = (dropList, side) => {
    for (const drop of dropList || []) {
      dropReasonCountMap[drop.reason] = dropReasonCountMap[drop.reason] || { factory: 0, lab: 0 };
      dropReasonCountMap[drop.reason][side] += 1;
    }
  };
  countDrop(factoryReport.droppedList, 'factory');
  countDrop(labTimeline.droppedList, 'lab');
  return {
    matchedList, factoryOnlyList, labOnlyList: labRemainList, dropReasonCountMap,
    summary: { factoryAdCount: factoryReport.adList.length, labAdCount: labTimeline.adList.length, matchedCount: matchedList.length },
  };
}

// 해설 문장에 줄바꿈이나 | 가 들어 있어도 마크다운 한 줄·표 한 칸에 들어가게 한다. 분포 비교 표도 같이 쓴다.
const toInlineText = (value) => String(value ?? '').replace(/\s*\n\s*/g, ' ');
export const toCellText = (value) => toInlineText(value).replace(/\|/g, '\\|');
const formatAdList = (adList) => adList.map((ad) => `${ad.type} "${toInlineText(ad.text)}" @${ad.playedMediaMs ?? '-'}`).join(' / ') || '없음';

export function formatCompareMarkdown(result) {
  const lineList = [
    `- AD 수: 공장 ${result.summary.factoryAdCount} · 실험실 ${result.summary.labAdCount} · 짝 ${result.summary.matchedCount}`,
    '', '| 유형 | 공장 문장 | 실험실 문장 | 재생 위치 차(ms) | 사건 시각 차(ms) |', '|---|---|---|---|---|',
    ...result.matchedList.map((match) => `| ${match.type} | ${toCellText(match.factoryText)} | ${toCellText(match.labText)} | ${match.playedDiffMs} | ${match.eventDiffMs ?? '-'} |`),
    '', `- 공장에만: ${formatAdList(result.factoryOnlyList)}`,
    `- 실험실에만: ${formatAdList(result.labOnlyList)}`,
    '', '| 버린 사유 | 공장 | 실험실 |', '|---|---|---|',
    ...Object.entries(result.dropReasonCountMap).map(([reason, count]) => `| ${toCellText(reason)} | ${count.factory} | ${count.lab} |`),
  ];
  return `${lineList.join('\n')}\n`;
}
