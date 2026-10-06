// LLM 은 결정적이지 않아 완전 일치는 기대하지 않는다(spec §7). 유형이 같고 삽입(재생) 위치가 ±toleranceMs 안이면 같은 AD 로 본다.
// 위치는 playedMediaMs 로 잰다. 실험실 outputMs 는 녹음 앞 무음을 포함해 공장 출력 시각과 기준이 다르다.
// 재생 위치가 없는 AD(실험실에서 재생 시각을 못 구한 경우)는 짝을 짓지 않고 한쪽에만 남긴다. null 을 0 으로 계산하면 영상 앞쪽 AD 와 잘못 짝지어진다.
const hasPlayedMs = (ad) => Number.isFinite(ad.playedMediaMs);

export function compareAdTimeline({ factoryReport, labTimeline, toleranceMs = 2000 }) {
  const labRemainList = [...labTimeline.adList];
  const matchedList = [];
  const factoryOnlyList = [];
  const sortedFactoryList = [
    ...factoryReport.adList.filter(hasPlayedMs).sort((left, right) => left.playedMediaMs - right.playedMediaMs),
    ...factoryReport.adList.filter((ad) => !hasPlayedMs(ad)),
  ];
  for (const factoryAd of sortedFactoryList) {
    let bestIndex = -1;
    let bestDiffMs = Infinity;
    if (hasPlayedMs(factoryAd)) {
      labRemainList.forEach((labAd, index) => {
        if (labAd.type !== factoryAd.type || !hasPlayedMs(labAd)) return;
        const diffMs = Math.abs(factoryAd.playedMediaMs - labAd.playedMediaMs);
        if (diffMs <= toleranceMs && diffMs < bestDiffMs) { bestIndex = index; bestDiffMs = diffMs; }
      });
    }
    if (bestIndex < 0) { factoryOnlyList.push(factoryAd); continue; }
    const [labAd] = labRemainList.splice(bestIndex, 1);
    const hasEventMs = Number.isFinite(factoryAd.eventMediaMs) && Number.isFinite(labAd.eventMediaMs);
    matchedList.push({
      type: factoryAd.type, factoryText: factoryAd.text, labText: labAd.text,
      playedDiffMs: factoryAd.playedMediaMs - labAd.playedMediaMs,
      eventDiffMs: hasEventMs ? factoryAd.eventMediaMs - labAd.eventMediaMs : null,
    });
  }
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

// 해설 문장에 줄바꿈이나 | 가 들어 있어도 마크다운 한 줄·표 한 칸에 들어가게 한다.
const toInlineText = (value) => String(value ?? '').replace(/\s*\n\s*/g, ' ');
const toCellText = (value) => toInlineText(value).replace(/\|/g, '\\|');
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
