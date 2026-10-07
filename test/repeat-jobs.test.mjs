import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseFactoryArgs } from '../src/cli/parse-args.mjs';
import { listInputVideos } from '../src/input/video-list.mjs';
import { inspectVideoResult, buildManifest, formatSummary, formatJobLabel } from '../src/runner/manifest.mjs';
import { buildRepeatRecord } from '../src/runner/run-video-job.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const makeDir = (name) => makeTempDir(`factory-repeat-${name}-`);

function writeList(entryList) {
  const listPath = path.join(makeDir('list'), 'list.json');
  fs.writeFileSync(listPath, JSON.stringify(entryList));
  return listPath;
}

test('인자 --repeat: 1 이상 정수만 받고, 주지 않으면 인자 모양이 이전과 같다(1 번)', () => {
  assert.equal(parseFactoryArgs(['--input', 'a', '--repeat', '3']).repeatCount, 3);
  assert.equal(parseFactoryArgs(['--input', 'a', '--repeat', '1']).repeatCount, 1);
  assert.equal(Object.hasOwn(parseFactoryArgs(['--input', 'a']), 'repeatCount'), false);
  for (const value of ['0', '-2', '1.5', 'abc']) {
    assert.throws(() => parseFactoryArgs(['--input', 'a', '--repeat', value]), new RegExp(`--repeat 은 1 이상 정수여야 한다: ${value.replace('.', '\\.')}`), value);
  }
  assert.throws(() => parseFactoryArgs(['--input', 'a', '--repeat']), /--repeat 뒤에 값이 없다/);
});

test('작업 펼치기: --repeat 1 이면 작업 목록이 이전과 같고(회차 필드 없음), N 이면 영상마다 -r1..-rN 작업 N개를 영상 순서대로 낸다', async () => {
  const dirPath = makeDir('input');
  for (const name of ['b.mp4', 'a.mp4']) fs.writeFileSync(path.join(dirPath, name), '');
  const singleList = await listInputVideos({ input: dirPath, language: 'ko' });
  assert.deepEqual(await listInputVideos({ input: dirPath, language: 'ko', repeatCount: 1 }), singleList);
  assert.deepEqual(singleList, [
    { videoId: 'a', filePath: path.join(dirPath, 'a.mp4'), outStem: 'a', language: 'ko' },
    { videoId: 'b', filePath: path.join(dirPath, 'b.mp4'), outStem: 'b', language: 'ko' },
  ]);
  const jobList = await listInputVideos({ input: dirPath, language: 'ko', repeatCount: 3 });
  assert.deepEqual(jobList.map((job) => [job.videoId, job.outStem, job.videoOutStem, job.repeatIndex, job.repeatCount]), [
    ['a', 'a-r1', 'a', 1, 3], ['a', 'a-r2', 'a', 2, 3], ['a', 'a-r3', 'a', 3, 3],
    ['b', 'b-r1', 'b', 1, 3], ['b', 'b-r2', 'b', 2, 3], ['b', 'b-r3', 'b', 3, 3],
  ]);
  assert.deepEqual(jobList[4], { videoId: 'b', filePath: path.join(dirPath, 'b.mp4'), outStem: 'b-r2', language: 'ko', videoOutStem: 'b', repeatIndex: 2, repeatCount: 3 });
});

test('작업 펼치기: --limit 은 영상 수 기준이다', async () => {
  const dirPath = makeDir('limit');
  for (const name of ['a.mp4', 'b.mp4', 'c.mp4']) fs.writeFileSync(path.join(dirPath, name), '');
  const jobList = await listInputVideos({ input: dirPath, limit: 2, repeatCount: 2 });
  assert.deepEqual(jobList.map((job) => job.outStem), ['a-r1', 'a-r2', 'b-r1', 'b-r2']);
});

test('작업 펼치기: 같은 이름 -2·예약 이름 video-·끝말 바꾸기를 지난 이름에 -r<k> 를 붙여, 붙인 뒤의 이름도 대소문자까지 겹치지 않는다', async () => {
  const videoIdList = ['x', 'X', 'x-r1', 'x-2', 'manifest', 'summary.txt', 'repeat-summary', 'Repeat-Summary.json', '.factory.lock', 'y.log', 'z_SEEON_AD.json'];
  const jobList = await listInputVideos({ input: writeList(videoIdList.map((videoId) => ({ videoId, file: 'a.mp4' }))), repeatCount: 2 });
  assert.deepEqual(jobList.filter((job) => job.repeatIndex === 1).map((job) => job.videoOutStem), [
    'x', 'X-2', 'x-r1', 'x-2-2', 'video-manifest', 'video-summary.txt', 'video-repeat-summary', 'video-Repeat-Summary.json',
    'video-.factory.lock', 'y_log', 'z_SEEON_AD_json',
  ]);
  const outStemList = jobList.map((job) => job.outStem);
  assert.deepEqual(outStemList.slice(0, 6), ['x-r1', 'x-r2', 'X-2-r1', 'X-2-r2', 'x-r1-r1', 'x-r1-r2']);
  assert.equal(new Set(outStemList.map((outStem) => outStem.toLowerCase())).size, outStemList.length, outStemList.join(', '));
  // 실행 기록·잠금·다른 작업의 출력 파일 이름과도 겹치지 않는다.
  const recordNameSet = new Set(['manifest.json', 'summary.txt', 'repeat-summary.json', '.factory.lock']);
  const outputNameList = outStemList.flatMap((outStem) => [outStem, `${outStem}.log`, `${outStem}_SEEON_AD.mp3`, `${outStem}_SEEON_AD.json`]);
  assert.equal(new Set(outputNameList.map((name) => name.toLowerCase())).size, outputNameList.length);
  for (const outStem of outStemList) {
    assert.equal(recordNameSet.has(outStem.toLowerCase()), false, outStem);
    assert.ok(!/^(manifest|summary|repeat-summary)$/i.test(outStem.split('.')[0]) && !outStem.startsWith('.'), outStem);
  }
});

test('예약 이름: 반복 요약(repeat-summary.json)과 겹치는 이름은 --repeat 1 에서도 앞에 video- 를 붙인다', async () => {
  const jobList = await listInputVideos({ input: writeList([{ videoId: 'repeat-summary.json', file: 'a.mp4' }, { videoId: 'repeat-summaryX', file: 'b.mp4' }]) });
  assert.deepEqual(jobList.map((job) => job.outStem), ['video-repeat-summary.json', 'repeat-summaryX']);
});

test('재실행 정체: 회차(repeatIndex)는 견주고 반복 수(count)는 견주지 않으며, 회차 기록이 없는 이전 결과는 1회차로 본다', () => {
  const outDir = makeDir('identity');
  const job = { videoId: 'a', filePath: '/v/a.mp4', outStem: 'a-r2', language: 'ko', isPageTransitionIncluded: false };
  const writeReport = (extra) => {
    fs.writeFileSync(path.join(outDir, `${job.outStem}_SEEON_AD.mp3`), 'x');
    fs.writeFileSync(path.join(outDir, `${job.outStem}_SEEON_AD.json`), JSON.stringify({
      isComplete: true, video: { videoId: 'a', file: '/v/a.mp4', language: 'ko' }, config: { isPageTransitionIncluded: false }, ...extra,
    }));
  };
  writeReport({ repeat: { index: 2, count: 3 } });
  assert.deepEqual(inspectVideoResult({ outDir, ...job, repeatIndex: 2 }), { status: 'done', mismatchList: [] });
  assert.deepEqual(inspectVideoResult({ outDir, ...job, repeatIndex: 3 }), { status: 'mismatch', mismatchList: ['반복 회차 2 → 3'] });
  assert.deepEqual(inspectVideoResult({ outDir, ...job }), { status: 'done', mismatchList: [] }, '회차를 주지 않으면 견주지 않는다');
  writeReport({});
  assert.deepEqual(inspectVideoResult({ outDir, ...job, repeatIndex: 1 }), { status: 'done', mismatchList: [] });
  assert.deepEqual(inspectVideoResult({ outDir, ...job, repeatIndex: 2 }), { status: 'mismatch', mismatchList: ['반복 회차 1 → 2'] });
});

test('결과 JSON 의 repeat: 작업의 회차·반복 수, 회차가 없는 작업(--repeat 1)은 { index: 1, count: 1 }', () => {
  assert.deepEqual(buildRepeatRecord({ job: { videoId: 'a', outStem: 'a' } }), { index: 1, count: 1 });
  assert.deepEqual(buildRepeatRecord({ job: { videoId: 'a', outStem: 'a-r2', repeatIndex: 2, repeatCount: 3 } }), { index: 2, count: 3 });
});

test('summary: --repeat N 이면 머리줄에 작업 수(영상 × 반복)를, 작업 줄에 videoId 와 회차를 적고, 1 이면 이전과 같다', () => {
  const jobList = ['a', 'b'].flatMap((videoId) => [1, 2].map((repeatIndex) => ({
    videoId, outStem: `${videoId}-r${repeatIndex}`, videoOutStem: videoId, repeatIndex, repeatCount: 2,
  })));
  const manifest = buildManifest({
    previousManifest: null, runOptions: { repeatCount: 2 }, seeonMeet: { commit: 'abc', isDirty: false }, jobList,
    resultList: [
      { videoId: 'a', outStem: 'a-r1', status: 'done', adCount: 2 }, { videoId: 'a', outStem: 'a-r2', status: 'failed', errorMessage: '시간 초과' },
      { videoId: 'b', outStem: 'b-r1', status: 'done', adCount: 1, warningList: [{ code: 'vlm_timeout', count: 1, message: 'x' }] },
    ],
    skippedJobList: [], startedAt: 's', endedAt: null,
  });
  assert.deepEqual(manifest.videoList.map((video) => [video.videoId, video.repeatIndex, video.status]), [
    ['a', 1, 'done'], ['a', 2, 'failed'], ['b', 1, 'done'], ['b', 2, 'not_run'],
  ]);
  const summary = formatSummary(manifest);
  assert.match(summary, /^작업 4\(영상 2 × 반복 2\) · 완료 2\(경고 1\) · 실패 1 · 건너뜀 0 · 남음 1$/m);
  assert.match(summary, /^ {2}✔ a r1\/2: AD 2개$/m);
  assert.match(summary, /^ {2}✖ a r2\/2: 시간 초과$/m);
  assert.match(summary, /^ {2}✔ b r1\/2: AD 1개 ⚠ vlm_timeout 1$/m);
  assert.equal(formatJobLabel({ videoId: 'a', outStem: 'a' }), 'a');
  assert.equal(formatJobLabel({ videoId: 'a', outStem: 'a-r2', repeatIndex: 2, repeatCount: 3 }), 'a r2/3');
});
