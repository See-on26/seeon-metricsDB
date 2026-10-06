import fs from 'node:fs';
import { buildOutputPathMap } from '../../src/runner/output-paths.mjs';

// video-worker.mjs 와 같은 메시지 규약으로 도는 가짜 워커. 제품 파이프라인 없이 videoId 에 든 낱말로 결과를 고른다.
// crash → 결과 없이 종료 코드 137, fail → failed 메시지 뒤 종료 1, hang → 끝나지 않음, 그 밖 → progress 뒤 mp3·JSON 을 쓰고 done.
process.on('message', (message) => {
  if (message?.type !== 'run') return;
  const { job, outDir } = message;
  console.log(`[fake-worker] ${job.videoId} 시작 · 언어 ${job.language} · 전환 ${job.isPageTransitionIncluded}`);
  if (job.videoId.includes('crash')) {
    setTimeout(() => process.exit(137), 10);
    return;
  }
  if (job.videoId.includes('fail')) {
    console.error(`[fake-worker] ${job.videoId} 실패`);
    process.send({ type: 'failed', message: `${job.videoId} 영상 스트림이 없다` }, () => process.exit(1));
    return;
  }
  if (job.videoId.includes('hang')) {
    setInterval(() => {}, 1000);
    return;
  }
  process.send({ type: 'progress', videoId: job.videoId, videoTimeMs: 10000, durationMs: 60000, adCount: 1 });
  const pathMap = buildOutputPathMap({ outDir, outStem: job.outStem });
  fs.writeFileSync(pathMap.mp3Path, 'mp3');
  fs.writeFileSync(pathMap.jsonPath, JSON.stringify({ isComplete: true }));
  const result = {
    videoId: job.videoId, outStem: job.outStem, status: 'done', durationMs: 60000, processingMs: 1200, adCount: 2, droppedCount: 1,
    outputPathMap: { mp3: `${job.outStem}_SEEON_AD.mp3`, json: `${job.outStem}_SEEON_AD.json` },
  };
  process.send({ type: 'done', result }, () => process.exit(0));
});
