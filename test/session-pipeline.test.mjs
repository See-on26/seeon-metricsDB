import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMockServices } from './helpers/mock-services.mjs';
import { createTestClip } from './helpers/media-fixtures.mjs';
import { createVirtualClock } from '../src/clock/virtual-clock.mjs';
import { bootProductPipeline } from '../src/product/boot-pipeline.mjs';
import { createSessionSimulator } from '../src/session/session-simulator.mjs';
import { openSampleFrameReader } from '../src/media/frame-source.mjs';
import { probeVideo } from '../src/media/probe.mjs';
import { resolveFfmpegPaths } from '../src/media/ffmpeg.mjs';
import { readPipelineRecordList } from '../src/output/ad-report.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

// 제품 파이프라인은 프로세스마다 한 번만 세운다. 이 파일은 세션 하나만 돌린다.
const mock = await startMockServices();
Object.assign(process.env, mock.urlEnv);
delete process.env.AWS_BEARER_TOKEN_BEDROCK;
after(() => mock.close());

test('runToEnd 가 돌아오면 제품 기록 파일에 세션 끝 기록까지 다 쓰여 있다(파일 쓰기 정착)', { timeout: 60000 }, async () => {
  const { ffmpegPath, ffprobePath } = resolveFfmpegPaths({ env: process.env });
  const dirPath = makeTempDir('factory-session-pipeline-');
  const filePath = await createTestClip({ dirPath, fileName: 'gray.mp4', colorTimeline: [['gray', 3]], hasAudio: false });
  const probe = await probeVideo({ filePath, ffprobePath });
  const workDir = path.join(dirPath, 'work');
  fs.mkdirSync(workDir);
  const clock = createVirtualClock({ startWallMs: Date.now() });
  const { bridge } = bootProductPipeline({ outDir: workDir, clock, log: console });
  const frameReader = openSampleFrameReader({ filePath, ffmpegPath });
  const simulator = createSessionSimulator({
    clock, bridge, video: { videoId: 'gray', filePath, language: 'ko', probe },
    prep: { levelList: new Float32Array(Math.floor(probe.durationMs / 100)), segmentList: [], segmentBufferMap: new Map(), frameReader },
    options: { isPageTransitionIncluded: false, ffmpegPath }, workDir, log: console,
  });
  let result = null;
  try {
    await simulator.start();
    result = await simulator.runToEnd();
  } finally {
    frameReader.close();
  }
  const reasonList = readPipelineRecordList({ recordPath: result.recordPath }).map((record) => record.reason).filter(Boolean);
  assert.deepEqual(reasonList.slice(-3), ['회의 캡처 정지', '세션 종료', '세션 스냅샷 확정']);
  assert.equal(result.endResult.isOk, true);
});
