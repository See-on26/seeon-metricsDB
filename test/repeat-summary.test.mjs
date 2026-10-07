import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildManifest, formatSummary, writeRunRecord } from '../src/runner/manifest.mjs';
import { buildRepeatSummary, formatRepeatSummary } from '../src/runner/repeat-summary.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const makeDir = (name) => makeTempDir(`factory-repeat-summary-${name}-`);
const ad = (type, playedMediaMs, text) => ({ type, playedMediaMs, text });

function buildJobList({ videoId, repeatCount }) {
  return Array.from({ length: repeatCount }, (_, offset) => ({
    videoId, filePath: `/v/${videoId}.mp4`, outStem: `${videoId}-r${offset + 1}`, videoOutStem: videoId, repeatIndex: offset + 1, repeatCount, language: 'ko',
  }));
}

function writeReport({ outDir, outStem, report }) {
  fs.writeFileSync(path.join(outDir, `${outStem}_SEEON_AD.mp3`), 'mp3');
  fs.writeFileSync(path.join(outDir, `${outStem}_SEEON_AD.json`), typeof report === 'string' ? report : JSON.stringify(report));
}

const doneResult = (job, adCount) => ({ videoId: job.videoId, outStem: job.outStem, status: 'done', adCount });

// 영상 a: 3회 모두 완료(AD 2·3·2, 1회는 이전 실행 결과를 건너뜀). 영상 b: 1회 완료, 2회 실패, 3회는 중단으로 돌지 않음.
function buildFixture() {
  const outDir = makeDir('fixture');
  const aJobList = buildJobList({ videoId: 'a', repeatCount: 3 });
  const bJobList = buildJobList({ videoId: 'b', repeatCount: 3 });
  const aAdListList = [
    [ad('deixis', 10000, '빨간 막대'), ad('interpretation', 30000, '250 은 연봉')],
    [ad('deixis', 10200, '빨간 막대'), ad('interpretation', 30100, '250 은 연봉'), ad('visual_description', 45000, '여행 사진')],
    [ad('interpretation', 29800, '250 은 반기 연봉'), ad('deixis', 10900, '왼쪽 막대')],
  ];
  const aDroppedListList = [[{ reason: 'feature_off' }, { reason: 'feature_off' }], [{ reason: 'feature_off' }, { reason: 'rate-limited' }], []];
  aJobList.forEach((job, index) => writeReport({ outDir, outStem: job.outStem, report: { isComplete: true, adList: aAdListList[index], droppedList: aDroppedListList[index] } }));
  writeReport({ outDir, outStem: 'b-r1', report: { isComplete: true, adList: [ad('deixis', 5000, '표')], droppedList: [] } });
  const jobList = [...aJobList, ...bJobList];
  const manifest = buildManifest({
    previousManifest: { videoList: [{ ...aJobList[0], status: 'done', adCount: 2 }] }, runOptions: { repeatCount: 3 }, seeonMeet: {},
    jobList,
    resultList: [
      doneResult(aJobList[1], 3), doneResult(aJobList[2], 2), doneResult(bJobList[0], 1),
      { videoId: 'b', outStem: 'b-r2', status: 'failed', errorMessage: '시간 초과(30분) — 워커를 멈췄다' },
    ],
    skippedJobList: [aJobList[0]], startedAt: '2026-10-07T00:00:00.000Z', endedAt: '2026-10-07T00:10:00.000Z', interruptedBy: 'SIGINT',
  });
  return { outDir, manifest };
}

test('반복 요약: 영상마다 완료·실패 회차, 실행별 AD 수(평균·최소·최대)·분류별 수·버린 사유 수, AD 묶음을 낸다', () => {
  const { outDir, manifest } = buildFixture();
  const repeatSummary = buildRepeatSummary({ outDir, manifest });
  assert.deepEqual(Object.keys(repeatSummary), ['repeatCount', 'matchToleranceMs', 'startedAt', 'endedAt', 'interruptedBy', 'videoList']);
  assert.deepEqual([repeatSummary.repeatCount, repeatSummary.matchToleranceMs, repeatSummary.interruptedBy], [3, 2000, 'SIGINT']);
  const [aSummary, bSummary] = repeatSummary.videoList;
  assert.deepEqual(aSummary, {
    videoId: 'a', outStem: 'a', filePath: '/v/a.mp4', runCount: 3, completedRunList: [1, 2, 3], failedRunList: [],
    adCount: { countList: [2, 3, 2], mean: 2.33, min: 2, max: 3 },
    adCountByClass: { deixis: [1, 1, 1], interpretation: [1, 1, 1], visual_description: [0, 1, 0] },
    droppedReasonCountList: [{ feature_off: 2 }, { feature_off: 1, 'rate-limited': 1 }, {}],
    clusterList: [
      { type: 'deixis', hitRunCount: 3, completedRunCount: 3, hitRunList: [1, 2, 3], playedMediaMs: { median: 10200, min: 10000, max: 10900 }, textList: ['빨간 막대', '왼쪽 막대'] },
      { type: 'interpretation', hitRunCount: 3, completedRunCount: 3, hitRunList: [1, 2, 3], playedMediaMs: { median: 30000, min: 29800, max: 30100 }, textList: ['250 은 반기 연봉', '250 은 연봉'] },
      { type: 'visual_description', hitRunCount: 1, completedRunCount: 3, hitRunList: [2], playedMediaMs: { median: 45000, min: 45000, max: 45000 }, textList: ['여행 사진'] },
    ],
  });
  // 실패·돌지 않은 회차는 요약 수치에서 빠지고 failedRunList 에 사유와 함께 남는다.
  assert.deepEqual([bSummary.runCount, bSummary.completedRunList], [3, [1]]);
  assert.deepEqual(bSummary.failedRunList, [
    { repeatIndex: 2, reason: '시간 초과(30분) — 워커를 멈췄다' },
    { repeatIndex: 3, reason: '돌지 않았다(중단 등으로 띄우지 않음)' },
  ]);
  assert.deepEqual(bSummary.adCount, { countList: [1], mean: 1, min: 1, max: 1 });
  assert.deepEqual(bSummary.clusterList.map((cluster) => [cluster.hitRunCount, cluster.completedRunCount]), [[1, 1]]);
});

test('반복 요약: 끝났다고 기록된 회차라도 결과 JSON 을 읽지 못하거나 불완전하면 실패로 돌리고, 완료가 하나도 없으면 수치는 비운다', () => {
  const outDir = makeDir('broken');
  const jobList = buildJobList({ videoId: 'c', repeatCount: 3 });
  writeReport({ outDir, outStem: 'c-r1', report: '{"isComplete": tr' });
  writeReport({ outDir, outStem: 'c-r2', report: { isComplete: false, adList: [], droppedList: [] } });
  const manifest = buildManifest({
    previousManifest: null, runOptions: { repeatCount: 3 }, seeonMeet: {}, jobList,
    resultList: [doneResult(jobList[0], 1), doneResult(jobList[1], 0), { videoId: 'c', outStem: 'c-r3', status: 'failed', errorMessage: 'c 영상 스트림이 없다' }],
    skippedJobList: [], startedAt: 's', endedAt: 'e',
  });
  const [cSummary] = buildRepeatSummary({ outDir, manifest }).videoList;
  assert.deepEqual(cSummary.completedRunList, []);
  assert.deepEqual(cSummary.failedRunList.map((failed) => failed.repeatIndex), [1, 2, 3]);
  assert.match(cSummary.failedRunList[0].reason, /^결과 JSON 을 읽지 못했다: /);
  assert.equal(cSummary.failedRunList[1].reason, '결과가 불완전하다(isComplete=false)');
  assert.equal(cSummary.failedRunList[2].reason, 'c 영상 스트림이 없다');
  assert.deepEqual(cSummary.adCount, { countList: [], mean: null, min: null, max: null });
  assert.deepEqual([cSummary.adCountByClass, cSummary.droppedReasonCountList, cSummary.clusterList], [{}, [], []]);
  assert.equal(formatRepeatSummary({ videoList: [cSummary] }).split('\n')[1], '  c: 반복 3회(완료 0): 완료 결과 없음');
});

test('반복 요약 줄: 영상마다 "반복 N회(완료 c): AD 평균(최소~최대) · 늘 나온 AD · 가끔 나온 AD", 늘 = 완료 실행 전부', () => {
  const { outDir, manifest } = buildFixture();
  const text = formatRepeatSummary(buildRepeatSummary({ outDir, manifest }));
  assert.equal(text, [
    '반복 요약(같은 분류·재생 위치 ±2초면 같은 AD, 자세히는 repeat-summary.json)',
    '  a: 반복 3회(완료 3): AD 평균 2.3(2~3) · 늘 나온 AD 2 · 가끔 나온 AD 1',
    '  b: 반복 3회(완료 1): AD 평균 1(1~1) · 늘 나온 AD 1 · 가끔 나온 AD 0',
    '',
  ].join('\n'));
});

test('실행 기록 쓰기: 반복 요약을 주면 repeat-summary.json 을 쓰고 summary.txt 끝에 영상 줄을 더하며, 주지 않으면 이전과 같다', () => {
  const { outDir, manifest } = buildFixture();
  const repeatSummary = buildRepeatSummary({ outDir, manifest });
  writeRunRecord({ outDir, manifest, repeatSummary });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outDir, 'repeat-summary.json'), 'utf8')), repeatSummary);
  const summary = fs.readFileSync(path.join(outDir, 'summary.txt'), 'utf8');
  assert.equal(summary, `${formatSummary(manifest)}${formatRepeatSummary(repeatSummary)}`);
  assert.equal(formatSummary(manifest, repeatSummary), summary);
  assert.deepEqual(fs.readdirSync(outDir).filter((name) => name.endsWith('.tmp')), []);

  const singleDir = makeDir('single');
  writeRunRecord({ outDir: singleDir, manifest });
  assert.deepEqual(fs.readdirSync(singleDir).sort(), ['manifest.json', 'summary.txt']);
});
