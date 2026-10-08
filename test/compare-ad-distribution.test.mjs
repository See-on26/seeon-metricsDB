import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  compareAdDistribution, formatDistributionMarkdown, readDistributionInput, VIDEO_DURATION_TOLERANCE_MS,
} from '../src/compare/compare-ad-distribution.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const repoPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolPath = path.join(repoPath, 'tools/compare-lab.mjs');
// 실험실 ad-timeline.json 그대로(옆에 run.json 이 없다).
const labFixturePath = path.join(repoPath, 'test/fixtures/lab-ad-timeline-sample-5slides.json');

const ad = (type, playedMediaMs, text = `${type}@${playedMediaMs}`) => ({ type, playedMediaMs, text });
const toRunList = (adListList) => adListList.map((adList, index) => ({ runIndex: index + 1, adList, droppedList: [] }));
const formatHit = (cluster) => (cluster ? `${cluster.hitRunCount}/${cluster.completedRunCount}` : null);
const brief = (result) => result.rowList.map((row) => [row.type, formatHit(row.factory), formatHit(row.lab), row.medianDiffMs]);

// 공장 3회: 지시·해석은 매번, 묘사는 2회차만. 실험실 2회: 지시는 매번(공장보다 1.6초 늦게), 해석은 1회차만 3초 늦게, 묘사는 재생 위치 없음.
function buildRunListMap() {
  return {
    factoryRunList: toRunList([
      [ad('deixis', 10000, '빨간 막대'), ad('interpretation', 30000, '250 은 연봉')],
      [ad('deixis', 10600, '빨간 막대'), ad('interpretation', 30200, '250 은 연봉'), ad('visual_description', 45000, '여행 사진')],
      [ad('interpretation', 29900, '250 은 반기 연봉'), ad('deixis', 11200, '왼쪽 막대')],
    ]),
    labRunList: toRunList([
      [ad('deixis', 12400, '제도 변경 막대'), ad('interpretation', 33000, '250 은 반기 연봉')],
      [ad('deixis', 12000, '막대 그래프'), ad('visual_description', null, '재생 위치 없음')],
    ]),
  };
}

test('분포 비교: 양쪽을 실행끼리 묶은 뒤 분류가 같고 중앙값이 2초 안인 묶음끼리 짝짓고, 짝·한쪽에만 있는 묶음을 등장 비율과 함께 시각순으로 낸다', () => {
  const result = compareAdDistribution(buildRunListMap());
  assert.deepEqual(
    [result.factoryRunCount, result.labRunCount, result.factoryAdCountList, result.labAdCountList],
    [3, 2, [2, 3, 2], [2, 2]],
  );
  assert.deepEqual([result.factoryClusterCount, result.labClusterCount, result.matchedCount], [3, 3, 1]);
  // 해석은 중앙값 30000 ↔ 33000(3초)이라 짝이 아니고, 재생 위치가 없는 묶음은 짝 없이 맨 뒤에 온다.
  assert.deepEqual(brief(result), [
    ['deixis', '3/3', '2/2', -1600],
    ['interpretation', '3/3', null, null],
    ['interpretation', null, '1/2', null],
    ['visual_description', '1/3', null, null],
    ['visual_description', null, '1/2', null],
  ]);
  const [deixisRow] = result.rowList;
  assert.deepEqual(deixisRow.factory.playedMediaMs, { median: 10600, min: 10000, max: 11200 });
  assert.deepEqual(deixisRow.lab.playedMediaMs, { median: 12200, min: 12000, max: 12400 });
  assert.deepEqual(deixisRow.lab.textList, ['막대 그래프', '제도 변경 막대']);
});

test('분포 비교 짝: 실험실 비교와 같은 기준 — 중앙값 차가 정확히 2초면 짝, 넘거나 분류가 다르면 아니고, 가까운 묶음과 짝지으며 묶음 하나는 한 번만 쓴다', () => {
  const pairOf = (factoryAdList, labAdList) => brief(compareAdDistribution({ factoryRunList: toRunList([factoryAdList]), labRunList: toRunList([labAdList]) }));
  assert.deepEqual(pairOf([ad('deixis', 10000)], [ad('deixis', 12000)]), [['deixis', '1/1', '1/1', -2000]]);
  assert.deepEqual(pairOf([ad('deixis', 10000)], [ad('deixis', 12001)]), [['deixis', '1/1', null, null], ['deixis', null, '1/1', null]]);
  assert.deepEqual(pairOf([ad('deixis', 10000)], [ad('interpretation', 10000)]), [['deixis', '1/1', null, null], ['interpretation', null, '1/1', null]]);
  // 공장 10.0 은 실험실 8.5(1.5초)·11.0(1.0초) 중 가까운 11.0 과, 공장 12.0 은 남은 것 중 2초 안이 없어 공장에만 남는다.
  assert.deepEqual(pairOf([ad('deixis', 10000), ad('deixis', 12000)], [ad('deixis', 8500), ad('deixis', 11000)]), [
    ['deixis', null, '1/1', null], ['deixis', '1/1', '1/1', -1000], ['deixis', '1/1', null, null],
  ]);
});

test('분포 비교 표: 실행 수·실행별 AD 수·묶음 수 줄, 등장 비율(없으면 0/N)·재생 위치 중앙값(최소~최대)·문장 예시 표, 실행별 버린 사유 표', () => {
  const runListMap = buildRunListMap();
  runListMap.factoryRunList[0].droppedList = [{ reason: 'feature_off' }, { reason: 'feature_off' }];
  runListMap.factoryRunList[2].droppedList = [{ reason: 'rate-limited' }];
  runListMap.labRunList[1].droppedList = [{ reason: 'feature_off' }];
  runListMap.labRunList[0].adList[0].text = '막대 | 제도\n둘째 줄';
  const markdown = formatDistributionMarkdown(compareAdDistribution(runListMap));
  assert.match(markdown, /^- 실행 수: 공장 3 · 실험실 2$/m);
  assert.match(markdown, /^- 실행별 AD 수: 공장 2·3·2\(평균 2\.3\) · 실험실 2·2\(평균 2\)$/m);
  assert.match(markdown, /^- 묶음: 공장 3 · 실험실 3 · 짝 1 · 공장에만 2 · 실험실에만 2$/m);
  assert.match(markdown, /^\| deixis \| 3\/3 \| 2\/2 \| 10600\(10000~11200\) \| 12200\(12000~12400\) \| -1600 \| 빨간 막대 \/ 왼쪽 막대 \| 막대 그래프 \/ 막대 \\\| 제도 둘째 줄 \|$/m);
  assert.match(markdown, /^\| interpretation \| 3\/3 \| 0\/2 \| 30000\(29900~30200\) \| - \| - \| 250 은 반기 연봉 \/ 250 은 연봉 \| - \|$/m);
  assert.match(markdown, /^\| visual_description \| 0\/3 \| 1\/2 \| - \| 위치 없음 \| - \| - \| 재생 위치 없음 \|$/m);
  assert.match(markdown, /^\| feature_off \| 2·0·0 \| 0·1 \|$/m);
  assert.match(markdown, /^\| rate-limited \| 0·0·1 \| 0·0 \|$/m);
});

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, typeof value === 'string' ? value : JSON.stringify(value));
  return filePath;
}

const SAME_SEEON_MEET = { commit: 'aaaaaaa1', isDirty: false, dirtyHash: null };
const SAME_FACTORY = { commit: 'fffffff1', isDirty: false, dirtyHash: null };
const SAME_RESULT_CONFIG = { mode: 'delayed', delayMs: 10000, vlmModel: 'qwen' };

// 공장 결과 JSON 하나(같은 자리 video·seeonMeet·factory·config.resultConfig·isComplete 만 채운다).
function writeFactoryReport({
  dirPath, name, videoId = 'sample-5slides', file = '/v/sample-5slides.mp4', durationMs = 63700, isComplete = true, adList = [],
  seeonMeet = SAME_SEEON_MEET, factory = SAME_FACTORY, resultConfig = SAME_RESULT_CONFIG,
}) {
  return writeJson(path.join(dirPath, `${name}_SEEON_AD.json`), {
    schemaVersion: 1, isComplete, video: { videoId, file, durationMs, language: 'ko' }, seeonMeet, factory,
    config: { resultConfig }, adList, droppedList: [],
  });
}

// 실험실 결과 폴더 하나: ad-timeline.json 과 그 옆 run.json(영상 이름·재생기 영상 길이·완료 여부). runInfo 가 null 이면 run.json 을 두지 않는다.
function writeLabRun({ dirPath, name, runInfo = {}, adList = [] }) {
  const runDir = path.join(dirPath, name);
  if (runInfo) writeJson(path.join(runDir, 'run.json'), { videoName: 'sample-5slides.mp4', videoDurationMs: 63680, isComplete: true, ...runInfo });
  return writeJson(path.join(runDir, 'ad-timeline.json'), { adList, droppedList: [] });
}

test('분포 비교 입력: 공장 결과 JSON 과 실험실 ad-timeline.json(옆 run.json 으로 영상 확인)을 읽어 실행 목록으로 만든다', () => {
  const dirPath = makeTempDir('factory-distribution-input-');
  const factoryPathList = [1, 2].map((index) => writeFactoryReport({ dirPath, name: `sample-5slides-r${index}`, adList: [ad('deixis', 10000 + index)] }));
  const labPathList = ['145359', '144540'].map((name) => writeLabRun({ dirPath, name, adList: [ad('deixis', 12000)] }));
  const { factoryRunList, labRunList, warningList } = readDistributionInput({ factoryPathList, labPathList });
  assert.deepEqual(factoryRunList.map((run) => [run.runIndex, run.filePath, run.adList.map((item) => item.playedMediaMs)]), [
    [1, factoryPathList[0], [10001]], [2, factoryPathList[1], [10002]],
  ]);
  assert.deepEqual(labRunList.map((run) => [run.runIndex, run.filePath, run.droppedList]), [[1, labPathList[0], []], [2, labPathList[1], []]]);
  assert.deepEqual(warningList, []);
  // 목록 JSON 으로 돌린 공장 결과는 videoId 가 파일 이름과 달라도 영상 파일 이름이 실험실과 같으면 같은 영상이다.
  const listedPath = writeFactoryReport({ dirPath, name: 'q01', videoId: 'q01' });
  assert.equal(readDistributionInput({ factoryPathList: [listedPath], labPathList }).factoryRunList.length, 1);
  // 재생기 영상 길이는 ffprobe 길이와 조금 다를 수 있어 ±VIDEO_DURATION_TOLERANCE_MS 는 같은 영상으로 본다.
  const closePath = writeLabRun({ dirPath, name: 'close', runInfo: { videoDurationMs: 63700 + VIDEO_DURATION_TOLERANCE_MS } });
  assert.equal(readDistributionInput({ factoryPathList, labPathList: [closePath] }).labRunList.length, 1);
});

test('분포 비교 입력: 서로 다른 영상(공장 videoId·영상 길이, 실험실 영상 이름·길이, 공장 ↔ 실험실)을 섞으면 오류로 멈춘다', () => {
  const dirPath = makeTempDir('factory-distribution-mixed-');
  const factoryPath = writeFactoryReport({ dirPath, name: 'sample-5slides-r1' });
  const labPath = writeLabRun({ dirPath, name: 'lab-ok' });
  const mixedCaseList = [
    { factoryPathList: [factoryPath, writeFactoryReport({ dirPath, name: 'english-revenue-r1', videoId: 'english-revenue', file: '/v/english-revenue.mp4', durationMs: 31700 })], labPathList: [labPath] },
    { factoryPathList: [factoryPath, writeFactoryReport({ dirPath, name: 'same-id-r1', durationMs: 63700 + VIDEO_DURATION_TOLERANCE_MS + 1 })], labPathList: [labPath] },
    { factoryPathList: [factoryPath], labPathList: [labPath, writeLabRun({ dirPath, name: 'lab-other', runInfo: { videoName: 'english-revenue.mp4' } })] },
    { factoryPathList: [factoryPath], labPathList: [labPath, writeLabRun({ dirPath, name: 'lab-long', runInfo: { videoDurationMs: 90000 } })] },
    { factoryPathList: [factoryPath], labPathList: [writeLabRun({ dirPath, name: 'lab-en', runInfo: { videoName: 'english-revenue.mp4', videoDurationMs: 63700 } })] },
    { factoryPathList: [factoryPath], labPathList: [writeLabRun({ dirPath, name: 'lab-short', runInfo: { videoDurationMs: 31700 } })] },
  ];
  for (const [index, mixedCase] of mixedCaseList.entries()) {
    assert.throws(() => readDistributionInput(mixedCase), /^Error: 서로 다른 영상의 결과를 섞었다/, `case ${index}`);
  }
  assert.throws(() => readDistributionInput(mixedCaseList[0]), /sample-5slides-r1_SEEON_AD\.json\(영상 sample-5slides · 63700ms\) ↔ .*english-revenue-r1_SEEON_AD\.json\(영상 english-revenue · 31700ms\)/);
});

test('분포 비교 입력: 불완전한 결과는 빼고 경고하며, run.json 이 없는 실험실 결과는 영상 확인 없이 쓰고 경고한다. 한쪽에 남는 결과가 없거나 읽지 못하면 오류', () => {
  const dirPath = makeTempDir('factory-distribution-incomplete-');
  const factoryPathList = [
    writeFactoryReport({ dirPath, name: 'sample-5slides-r1' }),
    writeFactoryReport({ dirPath, name: 'sample-5slides-r2', isComplete: false }),
    writeFactoryReport({ dirPath, name: 'sample-5slides-r3', isComplete: null }),
  ];
  const labPathList = [writeLabRun({ dirPath, name: 'lab-ok' }), writeLabRun({ dirPath, name: 'lab-broken', runInfo: { isComplete: false } }), labFixturePath];
  const { factoryRunList, labRunList, warningList } = readDistributionInput({ factoryPathList, labPathList });
  assert.deepEqual(factoryRunList.map((run) => [run.runIndex, run.filePath]), [[1, factoryPathList[0]]]);
  assert.deepEqual(labRunList.map((run) => [run.runIndex, run.filePath]), [[1, labPathList[0]], [2, labFixturePath]]);
  assert.deepEqual(warningList, [
    `불완전한 결과라 뺀다(isComplete 가 true 가 아님): ${factoryPathList[1]}`,
    `불완전한 결과라 뺀다(isComplete 가 true 가 아님): ${factoryPathList[2]}`,
    `불완전한 결과라 뺀다(isComplete 가 true 가 아님): ${labPathList[1]}`,
    `실험실 run.json 이 없어 같은 영상인지·완료된 실행인지 보지 못했다(파일만 옮겼거나 정리 중 멈춘 실행): ${labFixturePath}`,
  ]);
  assert.throws(() => readDistributionInput({ factoryPathList: [factoryPathList[1]], labPathList }), /^Error: 공장 쪽에 견줄 완료 결과가 없다/);
  assert.throws(() => readDistributionInput({ factoryPathList: [path.join(dirPath, 'none.json')], labPathList }), /^Error: 공장 결과를 읽지 못했다\(.*none\.json\): /);
  const brokenRunInfoPath = writeLabRun({ dirPath, name: 'lab-bad-info', runInfo: null });
  writeJson(path.join(path.dirname(brokenRunInfoPath), 'run.json'), '{"videoName": ');
  assert.throws(() => readDistributionInput({ factoryPathList, labPathList: [brokenRunInfoPath] }), /^Error: 실험실 run\.json 을 읽지 못했다\(/);
});

test('분포 비교 입력: 공장 결과끼리 코드 버전(seeon-meet·공장 커밋·수정 지문)이나 결과 설정이 다르면 경고 한 줄을 남긴다(분포에서 빼지는 않는다)', () => {
  const dirPath = makeTempDir('factory-distribution-version-');
  const labPathList = [writeLabRun({ dirPath, name: 'lab-ok' })];
  const writeRun = (name, extra = {}) => writeFactoryReport({ dirPath, name, ...extra });
  const mixedPathList = [
    writeRun('sample-5slides-r1'),
    writeRun('sample-5slides-r2', { factory: { ...SAME_FACTORY, isDirty: true, dirtyHash: 'd1' } }),
    writeRun('sample-5slides-r3', { seeonMeet: { ...SAME_SEEON_MEET, commit: 'bbbbbbb2' }, resultConfig: { ...SAME_RESULT_CONFIG, vlmModel: 'other' } }),
    writeRun('sample-5slides-r4', { isComplete: false, seeonMeet: { ...SAME_SEEON_MEET, commit: 'ccccccc3' } }),
  ];
  const { factoryRunList, warningList } = readDistributionInput({ factoryPathList: mixedPathList, labPathList });
  assert.equal(factoryRunList.length, 3);
  // 빼는 결과(r4)는 견주지 않는다. 다른 곳은 정해진 순서로 한 번씩, 파일은 첫 결과와 처음 다른 결과를 적는다.
  assert.deepEqual(warningList.filter((warning) => warning.startsWith('공장 결과끼리')), [
    `공장 결과끼리 코드 버전·결과 설정이 다르다(다른 곳: seeon-meet · 공장 · 결과 설정) — 다른 버전의 결과가 한 분포에 섞인다: ${mixedPathList[0]} ↔ ${mixedPathList[1]}`,
  ]);
  // 결과 설정은 키가 하나만 늘거나 줄어도 다르다. 같으면 경고가 없다.
  const keyPathList = [writeRun('key-r1'), writeRun('key-r2', { resultConfig: { ...SAME_RESULT_CONFIG, isScaleEnabled: true } })];
  assert.deepEqual(readDistributionInput({ factoryPathList: keyPathList, labPathList }).warningList, [
    `공장 결과끼리 코드 버전·결과 설정이 다르다(다른 곳: 결과 설정) — 다른 버전의 결과가 한 분포에 섞인다: ${keyPathList[0]} ↔ ${keyPathList[1]}`,
  ]);
  assert.deepEqual(readDistributionInput({ factoryPathList: [writeRun('same-r1'), writeRun('same-r2')], labPathList }).warningList, []);
});

const runTool = (argList) => spawnSync(process.execPath, [toolPath, ...argList], { encoding: 'utf8' });

test('compare-lab 도구 새 형식: --factory <json>... --lab <ad-timeline.json>... 이면 분포 비교 표를 stdout 으로, 경고는 stderr 로 낸다', () => {
  const dirPath = makeTempDir('factory-distribution-tool-');
  const factoryPathList = [
    [ad('deixis', 21000, '빨간 막대'), ad('visual_description', 43500, '여행 사진')],
    [ad('deixis', 22900, '빨간 막대 그래프')],
    [ad('deixis', 21500, '막대')],
  ].map((adList, index) => writeFactoryReport({ dirPath, name: `sample-5slides-r${index + 1}`, adList }));
  const labPath = writeLabRun({ dirPath, name: 'lab-145359', adList: [ad('deixis', 51389, '평가 구조')] });
  const run = runTool(['--factory', ...factoryPathList, '--lab', labPath, labFixturePath]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^- 실행 수: 공장 3 · 실험실 2$/m);
  // 공장 지시 묶음(중앙값 21500)·묘사(43500)가 실험실 픽스처의 지시(21787)·묘사(42441)와 짝이고, 실험실 145359 의 지시(51389)는 실험실에만 있다.
  assert.match(run.stdout, /^\| deixis \| 3\/3 \| 1\/2 \| 21500\(21000~22900\) \| 21787\(21787~21787\) \| -287 \| /m);
  assert.match(run.stdout, /^\| visual_description \| 1\/3 \| 1\/2 \| 43500\(43500~43500\) \| 42441\(42441~42441\) \| 1059 \| /m);
  assert.match(run.stdout, /^\| deixis \| 0\/3 \| 1\/2 \| - \| 51389\(51389~51389\) \| - \| - \| 평가 구조 \|$/m);
  assert.match(run.stdout, /^\| rate-limited \| 0·0·0 \| 0·1 \|$/m);
  assert.equal(run.stderr, `경고: 실험실 run.json 이 없어 같은 영상인지·완료된 실행인지 보지 못했다(파일만 옮겼거나 정리 중 멈춘 실행): ${labFixturePath}\n`);
  // --lab 을 먼저 주거나 --factory 를 나눠 줘도 같다.
  const reordered = runTool(['--lab', labPath, labFixturePath, '--factory', factoryPathList[0], '--factory', ...factoryPathList.slice(1)]);
  assert.equal(reordered.stdout, run.stdout);
});

test('compare-lab 도구 새 형식: 서로 다른 영상을 섞거나 읽지 못하면 이유와 함께 2, 쪽 하나가 비거나 모르는 인자면 사용법과 함께 2 로 끝난다', () => {
  const dirPath = makeTempDir('factory-distribution-tool-error-');
  const factoryPath = writeFactoryReport({ dirPath, name: 'sample-5slides-r1' });
  const otherPath = writeFactoryReport({ dirPath, name: 'english-revenue-r1', videoId: 'english-revenue', file: '/v/english-revenue.mp4', durationMs: 31700 });
  const labPath = writeLabRun({ dirPath, name: 'lab' });
  const mixed = runTool(['--factory', factoryPath, otherPath, '--lab', labPath]);
  assert.equal(mixed.status, 2);
  assert.equal(mixed.stdout, '');
  assert.match(mixed.stderr, /^비교하지 못했다: 서로 다른 영상의 결과를 섞었다/);
  const missingFile = runTool(['--factory', path.join(dirPath, 'none.json'), '--lab', labPath]);
  assert.equal(missingFile.status, 2);
  assert.match(missingFile.stderr, /^비교하지 못했다: 공장 결과를 읽지 못했다/);
  for (const argList of [['--factory', factoryPath], ['--lab', labPath], ['--factory', '--lab', labPath], ['--factory', factoryPath, '--lab', labPath, '--tolerance', '3000'], [factoryPath, '--lab', labPath]]) {
    const run = runTool(argList);
    assert.equal(run.status, 2, argList.join(' '));
    assert.match(run.stderr, /^사용법: node tools\/compare-lab\.mjs <공장 _SEEON_AD\.json> <실험실 ad-timeline\.json>$/m, argList.join(' '));
    assert.match(run.stderr, /node tools\/compare-lab\.mjs --factory <공장 _SEEON_AD\.json>\.\.\. --lab <실험실 ad-timeline\.json>\.\.\.$/m, argList.join(' '));
  }
});
