import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AD_MATCH_TOLERANCE_MS, measureAdMatchDiffMs, pairAdList } from '../src/compare/compare-ad-timeline.mjs';
import { clusterRunAdList } from '../src/compare/ad-cluster.mjs';

const ad = (type, playedMediaMs, text = `${type}@${playedMediaMs}`) => ({ type, playedMediaMs, text });
const toRunList = (adListList) => adListList.map((adList, index) => ({ runIndex: index + 1, adList }));
const brief = (clusterList) => clusterList.map((cluster) => [cluster.type, cluster.hitRunList, cluster.playedMediaMs.median]);

test('짝 기준: 분류가 같고 재생 위치가 둘 다 있으며 차가 2초(경계 포함) 안이면 그 차, 아니면 null', () => {
  assert.equal(AD_MATCH_TOLERANCE_MS, 2000);
  assert.equal(measureAdMatchDiffMs({ left: ad('deixis', 10000), right: ad('deixis', 12000) }), 2000);
  assert.equal(measureAdMatchDiffMs({ left: ad('deixis', 12000), right: ad('deixis', 10500) }), 1500);
  assert.equal(measureAdMatchDiffMs({ left: ad('deixis', 10000), right: ad('deixis', 12001) }), null);
  assert.equal(measureAdMatchDiffMs({ left: ad('deixis', 10000), right: ad('interpretation', 10000) }), null);
  assert.equal(measureAdMatchDiffMs({ left: ad('deixis', null), right: ad('deixis', 0) }), null);
  assert.equal(measureAdMatchDiffMs({ left: ad('deixis', 10000), right: ad('deixis', 12500), toleranceMs: 2500 }), 2500);
});

test('짝 짓기(pairAdList): 왼쪽을 재생 위치 순으로 훑으며 남은 오른쪽 중 가장 가까운 것과 짝짓고, 오른쪽 하나는 한 번만 쓴다', () => {
  const leftList = [ad('deixis', 12500, '두 번째'), ad('deixis', 12000, '첫째'), ad('visual_description', null)];
  const rightList = [ad('deixis', 10000, '오른쪽'), ad('deixis', 13000, '가까운')];
  const { pairList, leftOnlyList, rightOnlyList } = pairAdList({ leftList, rightList });
  // 첫째(12.0)는 오른쪽(2.0초)·가까운(1.0초) 중 가까운 것과 짝이 되고, 두 번째(12.5)에 남은 오른쪽은 2.5초라 짝이 없다.
  assert.deepEqual(pairList.map(({ left, right }) => [left.text, right.text]), [['첫째', '가까운']]);
  assert.deepEqual(leftOnlyList.map((item) => item.text), ['두 번째', 'visual_description@null']);
  assert.deepEqual(rightOnlyList.map((item) => item.text), ['오른쪽']);
});

test('묶음: 모든 실행에 나온 AD 는 한 묶음(hit 3/3), 재생 위치 중앙값·최소·최대와 서로 다른 문장을 남긴다', () => {
  const clusterList = clusterRunAdList({ runList: toRunList([
    [ad('deixis', 10000, '빨간 막대'), ad('interpretation', 30000, '250 은 연봉')],
    [ad('deixis', 10600, '빨간 막대'), ad('interpretation', 30200, '250 은 연봉')],
    [ad('interpretation', 29900, '250 은 반기 연봉'), ad('deixis', 11200, '왼쪽 막대')],
  ]) });
  assert.deepEqual(clusterList, [
    { type: 'deixis', hitRunCount: 3, completedRunCount: 3, hitRunList: [1, 2, 3], playedMediaMs: { median: 10600, min: 10000, max: 11200 }, textList: ['빨간 막대', '왼쪽 막대'] },
    { type: 'interpretation', hitRunCount: 3, completedRunCount: 3, hitRunList: [1, 2, 3], playedMediaMs: { median: 30000, min: 29900, max: 30200 }, textList: ['250 은 반기 연봉', '250 은 연봉'] },
  ]);
});

test('묶음: 3번 중 1번만 나온 AD 는 hit 1/3 묶음으로 따로 남고, 묶음은 시각순이다', () => {
  const clusterList = clusterRunAdList({ runList: toRunList([
    [ad('deixis', 10000), ad('interpretation', 30000)],
    [ad('deixis', 10500), ad('visual_description', 45000), ad('interpretation', 30500)],
    [ad('interpretation', 29500), ad('deixis', 9800)],
  ]) });
  assert.deepEqual(clusterList.map((cluster) => [cluster.type, cluster.hitRunCount, cluster.completedRunCount, cluster.hitRunList]), [
    ['deixis', 3, 3, [1, 2, 3]], ['interpretation', 3, 3, [1, 2, 3]], ['visual_description', 1, 3, [2]],
  ]);
});

test('묶음: 한 실행 안의 가까운 같은 분류 AD 두 개는 한 묶음으로 합치지 않는다(한 실행은 한 묶음에 최대 하나)', () => {
  const clusterList = clusterRunAdList({ runList: toRunList([
    [ad('deixis', 10000, 'r1 첫째'), ad('deixis', 11000, 'r1 둘째')],
    [ad('deixis', 10400, 'r2')],
  ]) });
  assert.deepEqual(clusterList.map((cluster) => [cluster.hitRunList, cluster.textList]), [[[1, 2], ['r1 첫째', 'r2']], [[1], ['r1 둘째']]]);
});

test('묶음: 분류가 다르면 같은 자리라도 묶지 않고, 재생 위치가 없는 AD 는 홀로 묶음이 되어 맨 뒤에 온다', () => {
  const clusterList = clusterRunAdList({ runList: toRunList([
    [ad('deixis', 10000), ad('visual_description', null, '위치 없음')],
    [ad('interpretation', 10000), ad('visual_description', null, '위치 없음')],
  ]) });
  assert.deepEqual(clusterList.map((cluster) => [cluster.type, cluster.hitRunList, cluster.playedMediaMs]), [
    ['deixis', [1], { median: 10000, min: 10000, max: 10000 }],
    ['interpretation', [2], { median: 10000, min: 10000, max: 10000 }],
    ['visual_description', [1], { median: null, min: null, max: null }],
    ['visual_description', [2], { median: null, min: null, max: null }],
  ]);
});

test('묶음 규칙: 묶음 첫 AD(가장 이른 것)와 2초 안이어야 들어가 묶음 안 AD 끼리 모두 2초 안이고, 들어갈 묶음이 여럿이면 가장 가까운 것', () => {
  // 10.0 → 11.5 는 첫 AD 와 1.5초라 들어가고, 12.9 는 바로 앞 AD 와 1.4초지만 첫 AD 와 2.9초라 새 묶음이다.
  assert.deepEqual(brief(clusterRunAdList({ runList: toRunList([[ad('deixis', 10000)], [ad('deixis', 11500)], [ad('deixis', 12900)]]) })), [
    ['deixis', [1, 2], 10750], ['deixis', [3], 12900],
  ]);
  // 경계(정확히 2초)는 같은 AD 다.
  assert.deepEqual(brief(clusterRunAdList({ runList: toRunList([[ad('deixis', 10000)], [ad('deixis', 12000)]]) })), [['deixis', [1, 2], 11000]]);
  // r2 의 12.0 은 r1 의 10.0 묶음(2.0초)과 11.8 묶음(0.2초) 모두에 들어갈 수 있어 가까운 11.8 묶음에 넣는다.
  assert.deepEqual(brief(clusterRunAdList({ runList: toRunList([[ad('deixis', 10000), ad('deixis', 11800)], [ad('deixis', 12000)]]) })), [
    ['deixis', [1], 10000], ['deixis', [1, 2], 11900],
  ]);
});

test('묶음: 같은 입력이면 늘 같은 결과이고, 실행 안 AD 순서가 달라도 결과가 같다. 문장 예시는 서로 다른 것 최대 3개', () => {
  const runList = toRunList([
    [ad('deixis', 10000, 'a'), ad('interpretation', 20000, 'x'), ad('deixis', 10000, 'a2')],
    [ad('interpretation', 20100, 'y'), ad('deixis', 10300, 'b')],
    [ad('deixis', 9900, 'a'), ad('deixis', 10000, 'c')],
    [ad('deixis', 10100, 'd')],
    [ad('deixis', 10200, 'e')],
  ]);
  const first = clusterRunAdList({ runList });
  assert.deepEqual(clusterRunAdList({ runList }), first);
  assert.deepEqual(clusterRunAdList({ runList: runList.map((run) => ({ ...run, adList: [...run.adList].reverse() })) }), first);
  // 9.9(r3) 가 첫 묶음, 10.0 의 r1 'a' 는 그 묶음에, 같은 r1 의 'a2' 는 새 묶음(10.0)을 열고, 뒤의 AD 는 첫 AD 가 더 가까운 10.0 묶음으로 간다.
  assert.deepEqual(first.map((cluster) => [cluster.type, cluster.hitRunList, cluster.playedMediaMs.median, cluster.textList]), [
    ['deixis', [1, 3], 9950, ['a']],
    ['deixis', [1, 2, 3, 4, 5], 10100, ['a2', 'c', 'd']],
    ['interpretation', [1, 2], 20050, ['x', 'y']],
  ]);
});

test('묶음 성질(무작위 입력): 모든 AD 가 한 묶음에만 들고, 한 묶음에 한 실행은 하나뿐이며, 묶음 안 AD 끼리는 모두 짝 기준을 만족한다', () => {
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const typeList = ['deixis', 'interpretation', 'visual_description'];
  for (let round = 0; round < 50; round += 1) {
    const runList = toRunList(Array.from({ length: 2 + Math.floor(random() * 4) }, () => Array.from({ length: Math.floor(random() * 6) }, () => (
      ad(typeList[Math.floor(random() * typeList.length)], Math.round(random() * 12000), `t${Math.floor(random() * 4)}`)
    ))));
    const clusterList = clusterRunAdList({ runList });
    const totalAdCount = runList.reduce((sum, run) => sum + run.adList.length, 0);
    assert.equal(clusterList.reduce((sum, cluster) => sum + cluster.hitRunCount, 0), totalAdCount);
    for (const cluster of clusterList) {
      assert.equal(new Set(cluster.hitRunList).size, cluster.hitRunList.length);
      assert.ok(cluster.playedMediaMs.max - cluster.playedMediaMs.min <= AD_MATCH_TOLERANCE_MS, JSON.stringify(cluster));
    }
    const medianList = clusterList.map((cluster) => cluster.playedMediaMs.median);
    assert.deepEqual(medianList, [...medianList].sort((left, right) => left - right));
  }
});
