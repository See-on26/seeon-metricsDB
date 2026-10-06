import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleepReal } from 'node:timers/promises';
import { listInputVideos } from '../src/input/video-list.mjs';
import { parseFactoryArgs } from '../src/cli/parse-args.mjs';
import { runWorkerPool, forkVideoWorker } from '../src/runner/worker-pool.mjs';
import { isVideoDone, readManifest, buildManifest, formatSummary, formatRunStamp } from '../src/runner/manifest.mjs';
import { runPreflight, checkTcpPort, startProductTunnel } from '../src/runner/preflight.mjs';

const makeDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `factory-${name}-`));
const FAKE_WORKER_PATH = fileURLToPath(new URL('./helpers/fake-video-worker.mjs', import.meta.url));

test('인자: 기본값(동시 3·auto)과 잘못된 값', () => {
  assert.deepEqual(parseFactoryArgs(['--input', 'videos']), {
    input: 'videos', out: null, concurrency: 3, language: 'auto', isPageTransitionIncluded: false, isForced: false, limit: null,
  });
  assert.equal(parseFactoryArgs(['--input', 'a', '--concurrency', '2', '--language', 'en', '--include-page-transition', '--force', '--limit', '5', '--out', 'o']).limit, 5);
  assert.throws(() => parseFactoryArgs([]), /--input/);
  assert.throws(() => parseFactoryArgs(['--input', 'a', '--language', 'jp']), /ko·en·auto/);
  assert.throws(() => parseFactoryArgs(['--input', 'a', '--concurrency', '0']), /1 이상/);
});

test('인자: 모든 값을 읽고, 값 빠짐·모르는 인자·정수 아님은 Error', () => {
  assert.deepEqual(parseFactoryArgs(['--input', 'a', '--concurrency', '2', '--language', 'en', '--include-page-transition', '--force', '--limit', '5', '--out', 'o']), {
    input: 'a', out: 'o', concurrency: 2, language: 'en', isPageTransitionIncluded: true, isForced: true, limit: 5,
  });
  assert.throws(() => parseFactoryArgs(['--input']), /--input 뒤에 값이 없다/);
  assert.throws(() => parseFactoryArgs(['--input', 'a', '--out', '--force']), /--out 뒤에 값이 없다/);
  assert.throws(() => parseFactoryArgs(['--input', 'a', '--verbose']), /모르는 인자: --verbose/);
  assert.throws(() => parseFactoryArgs(['--input', 'a', '--limit', '1.5']), /--limit 은 1 이상 정수/);
  assert.throws(() => parseFactoryArgs(['--input', 'a', '--concurrency', 'abc']), /--concurrency 은 1 이상 정수/);
});

test('입력 폴더: 영상 확장자만 이름순, --limit, 같은 이름은 뒤에 -2', async () => {
  const dirPath = makeDir('input');
  for (const name of ['b.mp4', 'a.MOV', 'note.txt', 'c.webm']) fs.writeFileSync(path.join(dirPath, name), '');
  const jobList = await listInputVideos({ input: dirPath, language: 'ko', limit: 2 });
  assert.deepEqual(jobList.map((job) => [job.videoId, job.outStem, job.language]), [['a', 'a', 'ko'], ['b', 'b', 'ko']]);
});

test('입력 폴더: 숨김 파일(._ 메타 파일)·폴더는 영상으로 치지 않고, 경로는 절대 경로다', async () => {
  const dirPath = makeDir('input-hidden');
  for (const name of ['._a.mp4', '.b.mp4', 'c.mkv']) fs.writeFileSync(path.join(dirPath, name), '');
  fs.mkdirSync(path.join(dirPath, 'folder.mp4'));
  const jobList = await listInputVideos({ input: dirPath });
  assert.deepEqual(jobList, [{ videoId: 'c', filePath: path.join(dirPath, 'c.mkv'), outStem: 'c', language: 'auto' }]);
});

test('입력 목록 JSON: 실험 레포 videoList(file) 와 spec 표기(path) 둘 다, 상대 경로는 목록 파일 기준, 언어 없으면 기본', async () => {
  const dirPath = makeDir('list');
  fs.mkdirSync(path.join(dirPath, 'v'));
  const listPath = path.join(dirPath, 'questions.json');
  fs.writeFileSync(listPath, JSON.stringify({ videoList: [
    { videoId: 'v1', file: 'v/talk.mp4', language: 'en' },
    { videoId: 'v2', path: '/abs/talk.mp4' },
  ] }));
  const jobList = await listInputVideos({ input: listPath, language: 'auto' });
  assert.deepEqual(jobList.map((job) => [job.videoId, job.filePath, job.outStem, job.language]), [
    ['v1', path.join(dirPath, 'v/talk.mp4'), 'v1', 'en'], ['v2', '/abs/talk.mp4', 'v2', 'auto'],
  ]);
  fs.writeFileSync(listPath, JSON.stringify([{ videoId: 'x', file: 'a.mp4' }, { videoId: 'x', file: 'b.mp4' }]));
  assert.deepEqual((await listInputVideos({ input: listPath })).map((job) => job.outStem), ['x', 'x-2']);
});

test('입력 목록 JSON: 출력 이름은 붙인 이름·대소문자만 다른 이름과도 겹치지 않고, 경로 문자·점만 있는 이름은 바꾼다', async () => {
  const dirPath = makeDir('list-stem');
  const listPath = path.join(dirPath, 'list.json');
  fs.writeFileSync(listPath, JSON.stringify([
    { videoId: 'x', file: 'a.mp4' }, { videoId: 'x', file: 'b.mp4' }, { videoId: 'x-2', file: 'c.mp4' },
    { videoId: 'Talk', file: 'd.mp4' }, { videoId: 'talk', file: 'e.mp4' },
    { videoId: 'a/b:c', file: 'f.mp4' }, { videoId: '..', file: 'g.mp4' }, { file: 'dir/h.mp4' },
  ]));
  const jobList = await listInputVideos({ input: listPath });
  assert.deepEqual(jobList.map((job) => job.outStem), ['x', 'x-2', 'x-2-2', 'Talk', 'talk-2', 'a_b_c', 'video', 'h']);
  assert.equal(jobList[7].videoId, 'h');
});

test('입력 목록 JSON: 항목 언어가 ko·en·auto 가 아니거나 file 이 없거나 videoList 가 없으면 Error', async () => {
  const dirPath = makeDir('list-bad');
  const listPath = path.join(dirPath, 'list.json');
  fs.writeFileSync(listPath, JSON.stringify({ videoList: [{ videoId: 'v1', file: 'a.mp4', language: 'jp' }] }));
  await assert.rejects(listInputVideos({ input: listPath }), /1번째 항목.*ko·en·auto.*jp/);
  fs.writeFileSync(listPath, JSON.stringify({ videoList: [{ videoId: 'v1', file: 'a.mp4' }, { videoId: 'v2' }] }));
  await assert.rejects(listInputVideos({ input: listPath }), /2번째 항목에 file/);
  fs.writeFileSync(listPath, JSON.stringify({ items: [] }));
  await assert.rejects(listInputVideos({ input: listPath }), /videoList 배열이 없다/);
  fs.writeFileSync(listPath, 'not json');
  await assert.rejects(listInputVideos({ input: listPath }), /영상 폴더나 목록 JSON 이어야 한다/);
  await assert.rejects(listInputVideos({ input: path.join(dirPath, 'none') }), /입력 폴더·목록을 찾지 못했다/);
});

test('워커 풀: 동시에 concurrency 개까지만, 하나가 실패해도 나머지는 끝까지, 결과는 입력 순서', async () => {
  let runningCount = 0;
  let maxRunningCount = 0;
  const startWorker = (job) => ({
    kill() {},
    promise: (async () => {
      runningCount += 1;
      maxRunningCount = Math.max(maxRunningCount, runningCount);
      await sleepReal(20);
      runningCount -= 1;
      if (job.videoId === 'v2') throw new Error('ffmpeg 실패');
      return { videoId: job.videoId, outStem: job.videoId, status: 'done' };
    })(),
  });
  const resultList = await runWorkerPool({ jobList: ['v1', 'v2', 'v3', 'v4', 'v5'].map((videoId) => ({ videoId, outStem: videoId })), concurrency: 2, startWorker });
  assert.equal(maxRunningCount, 2);
  assert.deepEqual(resultList.map((result) => result.status), ['done', 'failed', 'done', 'done', 'done']);
  assert.match(resultList[1].errorMessage, /ffmpeg 실패/);
});

test('워커 풀: 워커를 띄우다 바로 던져도 실패로 기록하고, 시작·끝 사건을 영상마다 한 번씩 낸다', async () => {
  const eventList = [];
  const resultList = await runWorkerPool({
    jobList: [{ videoId: 'a', outStem: 'a' }, { videoId: 'b', outStem: 'b' }], concurrency: 3,
    startWorker: (job) => {
      if (job.videoId === 'a') throw new Error('로그 파일을 열지 못했다');
      return { kill() {}, promise: Promise.resolve({ videoId: 'b', outStem: 'b', status: 'done' }) };
    },
    onEvent: ({ type, job, result }) => eventList.push(`${type}:${job.videoId}${result ? `:${result.status}` : ''}`),
  });
  assert.deepEqual(resultList, [
    { videoId: 'a', outStem: 'a', status: 'failed', errorMessage: '로그 파일을 열지 못했다' },
    { videoId: 'b', outStem: 'b', status: 'done' },
  ]);
  assert.deepEqual(eventList.sort(), ['end:a:failed', 'end:b:done', 'start:a', 'start:b']);
  assert.deepEqual(await runWorkerPool({ jobList: [], concurrency: 3, startWorker: () => assert.fail('부르지 않는다') }), []);
});

test('워커가 결과 없이 죽으면(종료 코드 137) 실패로 기록하고 로그 파일을 남긴다', async () => {
  const outDir = makeDir('crash');
  const logPath = path.join(outDir, 'v.log');
  const { promise } = forkVideoWorker({
    job: { videoId: 'v', outStem: 'v' }, outDir, logPath, env: { PATH: process.env.PATH },
    workerPath: fileURLToPath(new URL('./helpers/crash-worker.mjs', import.meta.url)),
  });
  await assert.rejects(promise, /결과 없이 종료.*137/);
  assert.match(fs.readFileSync(logPath, 'utf8'), /곧 죽는다/);
});

test('워커 규약: run 을 보내면 progress 를 넘기고 done 의 result 로 끝난다, 콘솔은 로그 파일로', async () => {
  const outDir = makeDir('fork-done');
  const logPath = path.join(outDir, 'talk.log');
  const progressList = [];
  const { promise } = forkVideoWorker({
    job: { videoId: 'talk', outStem: 'talk', language: 'ko', isPageTransitionIncluded: false }, outDir, logPath,
    env: { PATH: process.env.PATH }, workerPath: FAKE_WORKER_PATH, onProgress: (progress) => progressList.push(progress),
  });
  const result = await promise;
  assert.equal(result.status, 'done');
  assert.equal(result.adCount, 2);
  assert.deepEqual(progressList, [{ type: 'progress', videoId: 'talk', videoTimeMs: 10000, durationMs: 60000, adCount: 1 }]);
  assert.match(fs.readFileSync(logPath, 'utf8'), /\[fake-worker\] talk 시작 · 언어 ko/);
  assert.equal(isVideoDone({ outDir, outStem: 'talk' }), true);
});

test('워커 규약: failed 메시지면 그 이유로 실패한다', async () => {
  const outDir = makeDir('fork-failed');
  const { promise } = forkVideoWorker({
    job: { videoId: 'deck-fail', outStem: 'deck-fail', language: 'auto' }, outDir, logPath: path.join(outDir, 'deck-fail.log'),
    env: { PATH: process.env.PATH }, workerPath: FAKE_WORKER_PATH,
  });
  await assert.rejects(promise, /^Error: deck-fail 영상 스트림이 없다$/);
});

test('워커 규약: kill 하면 결과 없이 끝나 실패로 기록된다', async () => {
  const outDir = makeDir('fork-kill');
  const worker = forkVideoWorker({
    job: { videoId: 'slow-hang', outStem: 'slow-hang', language: 'auto' }, outDir, logPath: path.join(outDir, 'slow-hang.log'),
    env: { PATH: process.env.PATH }, workerPath: FAKE_WORKER_PATH,
  });
  await sleepReal(200);
  worker.kill();
  await assert.rejects(worker.promise, /결과 없이 종료.*SIGKILL/);
});

test('재실행: mp3 와 isComplete JSON 이 다 있어야 끝난 영상이다', () => {
  const outDir = makeDir('resume');
  assert.equal(isVideoDone({ outDir, outStem: 'a' }), false);
  fs.writeFileSync(path.join(outDir, 'a_SEEON_AD.mp3'), 'x');
  fs.writeFileSync(path.join(outDir, 'a_SEEON_AD.json'), JSON.stringify({ isComplete: false }));
  assert.equal(isVideoDone({ outDir, outStem: 'a' }), false);
  fs.writeFileSync(path.join(outDir, 'a_SEEON_AD.json'), JSON.stringify({ isComplete: true }));
  assert.equal(isVideoDone({ outDir, outStem: 'a' }), true);
  fs.writeFileSync(path.join(outDir, 'a_SEEON_AD.json'), '{"isComplete": tr');
  assert.equal(isVideoDone({ outDir, outStem: 'a' }), false, '쓰다 만 JSON');
});

test('manifest: 이전 결과를 이어 붙이고 실패 이유·요약을 낸다', () => {
  const manifest = buildManifest({
    previousManifest: { videoList: [{ videoId: 'old', outStem: 'old', status: 'done', adCount: 3 }] },
    runOptions: { concurrency: 3, language: 'auto' }, seeonMeet: { commit: 'c0ebca0', isDirty: false },
    jobList: [{ videoId: 'old', outStem: 'old' }, { videoId: 'a', outStem: 'a' }, { videoId: 'b', outStem: 'b' }],
    resultList: [{ videoId: 'a', outStem: 'a', status: 'done', adCount: 2, durationMs: 60000, processingMs: 20000 }, { videoId: 'b', outStem: 'b', status: 'failed', errorMessage: '영상 스트림이 없다' }],
    skippedJobList: [{ videoId: 'old', outStem: 'old' }], startedAt: '2026-10-06T00:00:00.000Z', endedAt: '2026-10-06T00:01:00.000Z',
  });
  assert.deepEqual(manifest.videoList.map((video) => [video.videoId, video.status]), [['old', 'done'], ['a', 'done'], ['b', 'failed']]);
  assert.deepEqual(manifest.counts, { total: 3, done: 2, failed: 1, skipped: 1 });
  assert.match(formatSummary(manifest), /실패 1/);
  assert.match(formatSummary(manifest), /b: 영상 스트림이 없다/);
  assert.equal(formatRunStamp(new Date(2026, 9, 6, 9, 5, 7)), '20261006-090507');
});

test('manifest: 건너뛴 영상은 이전 기록(AD 수)을 살리고, 이전 기록이 없어도 끝남으로 남는다', () => {
  const manifest = buildManifest({
    previousManifest: { videoList: [{ videoId: 'old', outStem: 'old', status: 'done', adCount: 3, processingMs: 9000 }] },
    runOptions: {}, seeonMeet: { commit: null, isDirty: null },
    jobList: [{ videoId: 'old', outStem: 'old' }, { videoId: 'lost', outStem: 'lost' }],
    resultList: [], skippedJobList: [{ videoId: 'old', outStem: 'old' }, { videoId: 'lost', outStem: 'lost' }],
    startedAt: 's', endedAt: 'e',
  });
  assert.deepEqual(manifest.videoList, [
    { videoId: 'old', outStem: 'old', status: 'done', adCount: 3, processingMs: 9000, isSkipped: true },
    { videoId: 'lost', outStem: 'lost', status: 'done', isSkipped: true },
  ]);
  const summary = formatSummary(manifest);
  assert.match(summary, /seeon-meet -/);
  assert.match(summary, /old: AD 3개 \(이전 실행\)/);
  assert.match(summary, /lost: AD -개 \(이전 실행\)/);
});

test('manifest 읽기: 없으면 null, 있으면 객체', () => {
  const outDir = makeDir('manifest-read');
  assert.equal(readManifest({ outDir }), null);
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ videoList: [] }));
  assert.deepEqual(readManifest({ outDir }), { videoList: [] });
});

test('시작 전 점검: 닫힌 GPU 포트와 Bedrock 토큰 없음을 이유와 함께 낸다', async () => {
  const pipelineConfig = {
    vlmUrl: 'http://127.0.0.1:8801/v1/chat/completions', asrUrl: 'http://127.0.0.1:8802/asr',
    ttsUrl: 'http://127.0.0.1:8803/tts', embedUrl: 'http://127.0.0.1:8804/embed', bedrockApiKey: '',
  };
  const { problemList, closedPortList } = await runPreflight({
    pipelineConfig, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe',
    checkPort: async ({ port }) => port !== 8802, runVersion: async () => Buffer.from('ok'),
  });
  assert.deepEqual(closedPortList, ['ASR 127.0.0.1:8802']);
  assert.ok(problemList.some((problem) => problem.includes('AWS_BEARER_TOKEN_BEDROCK')));
});

test('시작 전 점검: ffmpeg·ffprobe 를 못 돌리면 이유를 내고, 포트 없는 주소는 프로토콜 기본 포트로 본다', async () => {
  const checkedList = [];
  const { problemList, closedPortList } = await runPreflight({
    pipelineConfig: {
      vlmUrl: 'https://gpu.example.com/v1/chat/completions', asrUrl: 'http://gpu.example.com/asr',
      ttsUrl: 'http://127.0.0.1:18803/tts', embedUrl: 'http://127.0.0.1:18804/embed', bedrockApiKey: 'token',
    },
    ffmpegPath: '/없는/ffmpeg', ffprobePath: 'ffprobe',
    checkPort: async ({ host, port }) => { checkedList.push(`${host}:${port}`); return true; },
    runVersion: async (binaryPath) => { if (binaryPath.includes('없는')) throw new Error('ENOENT'); return Buffer.from('ok'); },
  });
  assert.deepEqual(checkedList, ['gpu.example.com:443', 'gpu.example.com:80', '127.0.0.1:18803', '127.0.0.1:18804']);
  assert.deepEqual(closedPortList, []);
  assert.deepEqual(problemList.length, 1);
  assert.match(problemList[0], /^ffmpeg 를 실행하지 못했다\(\/없는\/ffmpeg\)/);
});

test('시작 전 점검: 실제 ffmpeg·ffprobe -version 은 통과한다', async () => {
  const { problemList } = await runPreflight({
    pipelineConfig: { vlmUrl: 'http://127.0.0.1:1/v', asrUrl: 'http://127.0.0.1:1/a', ttsUrl: 'http://127.0.0.1:1/t', embedUrl: 'http://127.0.0.1:1/e', bedrockApiKey: 'token' },
    ffmpegPath: process.env.SEEON_FACTORY_FFMPEG || 'ffmpeg', ffprobePath: process.env.SEEON_FACTORY_FFPROBE || 'ffprobe',
    checkPort: async () => true,
  });
  assert.deepEqual(problemList, []);
});

test('TCP 포트 점검: 듣는 포트는 열림, 닫힌 포트는 닫힘(GPU 실서비스 포트는 쓰지 않는다)', async () => {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const openPort = server.address().port;
  assert.equal(await checkTcpPort({ host: '127.0.0.1', port: openPort, timeoutMs: 1000 }), true);
  await new Promise((resolve) => { server.close(resolve); });
  assert.equal(await checkTcpPort({ host: '127.0.0.1', port: openPort, timeoutMs: 1000 }), false);
});

const TUNNEL_PIPELINE_CONFIG = {
  vlmUrl: 'http://127.0.0.1:8801/v1/chat/completions', asrUrl: 'http://127.0.0.1:8802/asr',
  ttsUrl: 'http://127.0.0.1:8803/tts', ttsLongUrl: 'http://127.0.0.1:8803/tts-long', embedUrl: 'http://127.0.0.1:8804/embed',
};

function makeKeyEnv() {
  const keyPath = path.join(makeDir('tunnel-key'), 'gpu-tunnel-key');
  fs.writeFileSync(keyPath, 'not-a-real-key');
  return { SEEON_GPU_SSH_KEY: keyPath };
}

test('제품 터널: SEEON_GPU_TUNNEL=off 이거나 키가 없으면 열지 않고 null', async () => {
  const createTunnel = () => assert.fail('터널을 만들지 않는다');
  assert.equal(await startProductTunnel({ env: { ...makeKeyEnv(), SEEON_GPU_TUNNEL: 'off' }, pipelineConfig: TUNNEL_PIPELINE_CONFIG, createTunnel }), null);
  assert.equal(await startProductTunnel({ env: {}, pipelineConfig: TUNNEL_PIPELINE_CONFIG, createTunnel }), null);
});

test('제품 터널: 제품 설정으로 만든 터널이 연결되면 돌려준다', async () => {
  const createdList = [];
  const statusList = ['connecting', 'connecting', 'connected'];
  const tunnel = await startProductTunnel({
    env: { ...makeKeyEnv(), SEEON_GPU_SSH_HOST: 'gpu.example.com' }, pipelineConfig: TUNNEL_PIPELINE_CONFIG, waitMs: 2000, pollMs: 5,
    createTunnel: ({ tunnelConfig, forwardList }) => {
      createdList.push({ host: tunnelConfig.host, forwardList });
      return { start: async () => {}, stop: async () => {}, getStatus: () => ({ status: statusList.shift() || 'connected' }) };
    },
  });
  assert.ok(tunnel);
  assert.deepEqual(createdList, [{
    host: 'gpu.example.com',
    forwardList: [8801, 8802, 8803, 8804].map((port) => ({ localPort: port, remotePort: port })),
  }]);
});

test('제품 터널: 제때 연결되지 않거나 start 가 던지면 터널을 닫고 Error', async () => {
  let stopCount = 0;
  const makeTunnel = ({ isStartThrown }) => () => ({
    start: async () => { if (isStartThrown) throw new Error('Cannot find module ssh2'); },
    stop: async () => { stopCount += 1; },
    getStatus: () => ({ status: 'reconnecting', reason: 'auth_failed', retryInMs: 2000 }),
  });
  await assert.rejects(
    startProductTunnel({ env: makeKeyEnv(), pipelineConfig: TUNNEL_PIPELINE_CONFIG, waitMs: 30, pollMs: 5, createTunnel: makeTunnel({ isStartThrown: false }) }),
    /^Error: GPU 터널이 제때 연결되지 않았다 — 마지막 상태: 다시 연결 중 \(인증 실패\)$/,
  );
  assert.equal(stopCount, 1);
  await assert.rejects(
    startProductTunnel({ env: makeKeyEnv(), pipelineConfig: TUNNEL_PIPELINE_CONFIG, waitMs: 30, pollMs: 5, createTunnel: makeTunnel({ isStartThrown: true }) }),
    /ssh2/,
  );
  assert.equal(stopCount, 2);
});

// ssh2 가 깔려 있으면 실제 SSH 연결을 시도하게 되므로 이 경우만 건너뛴다.
const isSsh2Installed = fs.existsSync(path.join(fileURLToPath(new URL('../seeon-meet/node_modules/ssh2', import.meta.url))));

test('제품 터널: ssh2 가 제품 쪽에 없으면 포트를 열기 전에 설치 방법을 담은 Error', { skip: isSsh2Installed && 'seeon-meet 에 ssh2 가 있다' }, async () => {
  // 점검이 빠져 실제 터널이 포트를 열더라도 GPU 실서비스 포트에 닿지 않게 비어 있는 포트를 준다.
  const server = net.createServer();
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const freeUrl = `http://127.0.0.1:${server.address().port}/x`;
  await new Promise((resolve) => { server.close(resolve); });
  const pipelineConfig = { vlmUrl: freeUrl, asrUrl: freeUrl, ttsUrl: freeUrl, ttsLongUrl: freeUrl, embedUrl: freeUrl };
  await assert.rejects(
    startProductTunnel({ env: makeKeyEnv(), pipelineConfig, waitMs: 30 }),
    /제품 GPU 터널 모듈을 불러오지 못했다.*npm --prefix seeon-meet ci --omit=dev/,
  );
});
