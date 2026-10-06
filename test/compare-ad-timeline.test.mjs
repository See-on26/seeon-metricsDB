import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareAdTimeline, formatCompareMarkdown } from '../src/compare/compare-ad-timeline.mjs';

const repoPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 실험실(experiment, 균형, 평가 프리셋, ko)로 sample-5slides 를 돌린 ad-timeline.json 그대로다.
const labFixturePath = path.join(repoPath, 'test/fixtures/lab-ad-timeline-sample-5slides.json');
const readLabFixture = () => JSON.parse(fs.readFileSync(labFixturePath, 'utf8'));

// buildAdReport 가 내는 모양의 공장 기록. 비교에 쓰는 필드만 채운다.
function createFactoryReport() {
  return {
    schemaVersion: 1,
    adList: [
      { id: 'ad-001', type: 'deixis', aid: 'A2', narrationClass: 'deixis', text: '빨간 막대 그래프로 제도 변경 설명', eventMediaMs: 17800, playedMediaMs: 22900, outputMs: 22900, durationMs: 2600 },
      { id: 'ad-002', type: 'visual_description', aid: 'A4', narrationClass: 'silence_based', text: '여행 사진과 글이 나열된 페이지', eventMediaMs: 42900, playedMediaMs: 44500, outputMs: 47100, durationMs: 3000 },
    ],
    droppedList: [
      { text: '슬라이드 1', type: 'page_transition', eventMediaMs: 12000, reason: 'feature_off' },
      { text: '슬라이드 2', type: 'page_transition', eventMediaMs: 16500, reason: 'feature_off' },
      { text: '슬라이드 3', type: 'page_transition', eventMediaMs: 27000, reason: 'feature_off' },
      { text: '슬라이드 4', type: 'page_transition', eventMediaMs: 38000, reason: 'feature_off' },
      { text: '끝내 못 튼 해설', type: 'deixis', eventMediaMs: 60000, reason: 'not_played' },
    ],
  };
}

test('같은 유형·삽입 위치 ±2초 안이면 짝을 짓고, 남는 것은 한쪽만으로, 버린 사유는 수를 센다', () => {
  const factoryReport = {
    adList: [
      { type: 'deixis', text: '반기 연봉 그래프', eventMediaMs: 17000, playedMediaMs: 33500 },
      { type: 'visual_description', text: '여행 사진', eventMediaMs: 42000, playedMediaMs: 42100 },
      { type: 'deixis', text: '오른쪽 카드', eventMediaMs: 9000, playedMediaMs: 12000 },
    ],
    droppedList: [{ reason: 'feature_off' }, { reason: 'feature_off' }, { reason: 'rate-limited' }],
  };
  const labTimeline = {
    adList: [
      { type: 'deixis', text: '반기 연봉 조정 그래프', eventMediaMs: 17403, playedMediaMs: 34026 },
      { type: 'visual_description', text: '이미지 제시', eventMediaMs: 42314, playedMediaMs: 42396 },
    ],
    droppedList: [{ reason: 'feature_off' }, { reason: 'rate-limited' }, { reason: 'rate-limited' }],
  };
  const result = compareAdTimeline({ factoryReport, labTimeline });
  assert.equal(result.summary.matchedCount, 2);
  assert.deepEqual(result.matchedList.map((match) => [match.type, match.playedDiffMs]), [['deixis', -526], ['visual_description', -296]]);
  assert.deepEqual(result.factoryOnlyList.map((ad) => ad.text), ['오른쪽 카드']);
  assert.deepEqual(result.labOnlyList, []);
  assert.deepEqual(result.dropReasonCountMap, { feature_off: { factory: 2, lab: 1 }, 'rate-limited': { factory: 1, lab: 2 } });
  assert.match(formatCompareMarkdown(result), /\| deixis \|/);
});

test('실험실 ad-timeline.json 과 공장 기록: 재생 위치(playedMediaMs)로 견주고 ±2초를 넘으면 양쪽에 따로 남긴다', () => {
  const result = compareAdTimeline({ factoryReport: createFactoryReport(), labTimeline: readLabFixture() });
  assert.deepEqual(result.summary, { factoryAdCount: 2, labAdCount: 2, matchedCount: 1 });
  assert.deepEqual(result.matchedList, [{
    type: 'deixis', factoryText: '빨간 막대 그래프로 제도 변경 설명', labText: '2022년 1월부터 현재까지의 제도 변경 보며 설명함',
    playedDiffMs: 1113, eventDiffMs: 333,
  }]);
  assert.deepEqual(result.factoryOnlyList.map((ad) => [ad.type, ad.playedMediaMs]), [['visual_description', 44500]]);
  assert.deepEqual(result.labOnlyList.map((ad) => [ad.type, ad.playedMediaMs]), [['visual_description', 42441]]);
  assert.deepEqual(result.dropReasonCountMap, {
    feature_off: { factory: 4, lab: 5 }, not_played: { factory: 1, lab: 0 }, 'rate-limited': { factory: 0, lab: 1 },
  });
  const widened = compareAdTimeline({ factoryReport: createFactoryReport(), labTimeline: readLabFixture(), toleranceMs: 2500 });
  assert.deepEqual(widened.matchedList.map((match) => [match.type, match.playedDiffMs]), [['deixis', 1113], ['visual_description', 2059]]);
  assert.deepEqual([widened.factoryOnlyList, widened.labOnlyList], [[], []]);
});

test('짝 짓기: 경계(정확히 2초)는 짝, 유형이 다르면 짝이 아니고, 실험실 AD 하나는 한 번만 쓴다, 재생 위치가 없으면 짝을 짓지 않는다', () => {
  const result = compareAdTimeline({
    factoryReport: {
      adList: [
        { type: 'deixis', text: '경계', eventMediaMs: 1000, playedMediaMs: 12000 },
        { type: 'deixis', text: '두 번째 후보', eventMediaMs: 1500, playedMediaMs: 12500 },
        { type: 'interpretation', text: '유형 다름', eventMediaMs: 20000, playedMediaMs: 20000 },
        { type: 'visual_description', text: '재생 위치 없음', eventMediaMs: 30000, playedMediaMs: null },
      ],
      droppedList: [],
    },
    labTimeline: {
      adList: [
        { type: 'deixis', text: '실험실 지시', eventMediaMs: null, playedMediaMs: 10000 },
        { type: 'visual_description', text: '실험실 묘사', eventMediaMs: 20500, playedMediaMs: 20500 },
        { type: 'interpretation', text: '실험실 재생 위치 없음', eventMediaMs: 1000, playedMediaMs: null },
        { type: 'visual_description', text: '영상 앞 묘사', eventMediaMs: 1000, playedMediaMs: 1500 },
      ],
      droppedList: [],
    },
  });
  assert.deepEqual(result.matchedList, [{ type: 'deixis', factoryText: '경계', labText: '실험실 지시', playedDiffMs: 2000, eventDiffMs: null }]);
  assert.deepEqual(result.factoryOnlyList.map((ad) => ad.text), ['두 번째 후보', '유형 다름', '재생 위치 없음']);
  assert.deepEqual(result.labOnlyList.map((ad) => ad.text), ['실험실 묘사', '실험실 재생 위치 없음', '영상 앞 묘사']);
  assert.deepEqual(result.dropReasonCountMap, {});
  assert.equal(result.summary.matchedCount, 1);
});

test('표: 문장 속 | 와 줄바꿈은 표를 깨지 않게 바꾸고, 한쪽만 없으면 "없음"을 쓴다', () => {
  const markdown = formatCompareMarkdown(compareAdTimeline({
    factoryReport: { adList: [{ type: 'deixis', text: 'A | B\n둘째 줄', eventMediaMs: 0, playedMediaMs: 5000 }], droppedList: [{ reason: 'feature_off' }] },
    labTimeline: { adList: [{ type: 'deixis', text: '실험실', eventMediaMs: 0, playedMediaMs: 5100 }], droppedList: [] },
  }));
  assert.match(markdown, /^- AD 수: 공장 1 · 실험실 1 · 짝 1$/m);
  assert.match(markdown, /^\| deixis \| A \\\| B 둘째 줄 \| 실험실 \| -100 \| 0 \|$/m);
  assert.match(markdown, /^- 공장에만: 없음$/m);
  assert.match(markdown, /^- 실험실에만: 없음$/m);
  assert.match(markdown, /^\| feature_off \| 1 \| 0 \|$/m);
});

test('compare-lab 도구: 두 JSON 경로를 받아 비교 표를 stdout 으로 내고, 인자가 모자라면 사용법과 함께 2 로 끝난다', () => {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-compare-'));
  const factoryJsonPath = path.join(dirPath, 'sample-5slides_SEEON_AD.json');
  fs.writeFileSync(factoryJsonPath, JSON.stringify(createFactoryReport()));
  const toolPath = path.join(repoPath, 'tools/compare-lab.mjs');
  const run = spawnSync(process.execPath, [toolPath, factoryJsonPath, labFixturePath], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^\| deixis \| 빨간 막대 그래프로 제도 변경 설명 \| 2022년 1월부터 현재까지의 제도 변경 보며 설명함 \| 1113 \| 333 \|$/m);
  assert.match(run.stdout, /^- 실험실에만: visual_description "이미지 제시, 여행 일기 형식의 사진과 글이 나열된 페이지" @42441$/m);
  assert.match(run.stdout, /^\| rate-limited \| 0 \| 1 \|$/m);
  const missing = spawnSync(process.execPath, [toolPath, factoryJsonPath], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /사용법: node tools\/compare-lab\.mjs/);
  fs.rmSync(dirPath, { recursive: true, force: true });
});
