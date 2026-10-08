import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMockServices } from './helpers/mock-services.mjs';
import { createTestClip } from './helpers/media-fixtures.mjs';
import { openSampleFrameReader } from '../src/media/frame-source.mjs';
import { runVideoJob } from '../src/runner/run-video-job.mjs';
import { isVideoDone } from '../src/runner/manifest.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

// 제품 파이프라인은 프로세스마다 한 번만 세운다. 이 파일은 영상 하나만 같은 프로세스에서 돌린다.
const mock = await startMockServices();
Object.assign(process.env, mock.urlEnv);
delete process.env.AWS_BEARER_TOKEN_BEDROCK;
after(() => mock.close());

const FRAME_ERROR_MESSAGE = 'ffmpeg 프레임 디코드 실패(종료 코드 1): 손상된 프레임';

test('프레임 읽기가 중간에 실패하면 mp3·JSON 은 남기되 JSON 을 isComplete=false·사유와 함께 쓰고 영상은 실패로 끝낸다', { timeout: 120000 }, async () => {
  const dirPath = makeTempDir('factory-job-');
  const filePath = await createTestClip({ dirPath, fileName: 'broken.mp4', colorTimeline: [['gray', 6]], hasAudio: false });
  const outDir = path.join(dirPath, 'out');
  const openFrameReader = (option) => {
    const realReader = openSampleFrameReader(option);
    return {
      readFrameAt: async (timeMs) => {
        if (timeMs >= 2000) throw new Error(FRAME_ERROR_MESSAGE);
        return realReader.readFrameAt(timeMs);
      },
      close: () => realReader.close(),
    };
  };
  const progressList = [];
  await assert.rejects(
    runVideoJob({
      job: { videoId: 'broken', filePath, outStem: 'broken', language: 'auto', isPageTransitionIncluded: false },
      outDir, log: { log() {}, warn() {} }, openFrameReader, onProgress: (progress) => progressList.push(progress),
    }),
    /결과가 불완전하다 — 프레임 읽기 실패\(2000ms\)/,
  );
  const report = JSON.parse(fs.readFileSync(path.join(outDir, 'broken_SEEON_AD.json'), 'utf8'));
  assert.equal(report.isComplete, false);
  assert.deepEqual(report.incompleteReasonList, [{ code: 'frame_source_error', message: FRAME_ERROR_MESSAGE, videoTimeMs: 2000 }]);
  assert.deepEqual(report.stats.frame.sourceError, { message: FRAME_ERROR_MESSAGE, videoTimeMs: 2000 });
  assert.equal(report.stats.frame.captureFailCount, 0);
  assert.equal(report.session.isDrainTimedOut, false);
  assert.deepEqual(
    [report.session.appendedTailMs, report.session.remainingTaskCount, report.session.inFlightCallCount], [0, 0, 0],
    '정상 배수: 붙인 원음·남은 작업·진행 중 호출이 없다',
  );
  assert.ok(fs.existsSync(path.join(outDir, 'broken_SEEON_AD.mp3')));
  assert.equal(isVideoDone({ outDir, outStem: 'broken' }), false, '다시 돌리면 이 영상을 다시 처리한다');
  assert.equal(JSON.stringify(report).includes('bedrockApiKey'), false);
  // 재실행 건너뛰기는 이 필드들이 지금 작업과 같은지 본다.
  assert.deepEqual(
    [report.video.videoId, report.video.file, report.video.language, report.config.isPageTransitionIncluded],
    ['broken', filePath, 'auto', false],
  );
  assert.deepEqual(progressList[0], { videoTimeMs: 0, durationMs: 6000, adCount: 0 }, '준비 전에 영상 길이를 먼저 알린다');
  assert.deepEqual(report.repeat, { index: 1, count: 1 }, '회차 필드가 없는 작업(--repeat 1)은 1회차 · 1번');
});
