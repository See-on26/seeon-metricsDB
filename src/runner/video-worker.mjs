import { runVideoJob } from './run-video-job.mjs';
import { killTrackedChildren } from '../media/ffmpeg.mjs';

// 워커 풀이 시간 초과·중단 때 SIGTERM 을 보낸다. 띄운 ffmpeg 가 고아로 남지 않게 정리하고 끝낸다(128 + 15).
const SIGTERM_EXIT_CODE = 143;
process.once('SIGTERM', () => {
  killTrackedChildren();
  process.exit(SIGTERM_EXIT_CODE);
});

// 영상 하나를 맡는 워커 프로세스. 가상 시계·제품 모듈 상태가 프로세스마다 따로라 다른 영상에 영향이 없다.
process.on('message', async (message) => {
  if (message?.type !== 'run') return;
  const { job, outDir } = message;
  try {
    const result = await runVideoJob({
      job, outDir, onProgress: (progress) => process.send?.({ type: 'progress', videoId: job.videoId, ...progress }),
    });
    process.send({ type: 'done', result }, () => process.exit(0));
  } catch (error) {
    console.error(`[factory] ${job.videoId} 실패: ${error.stack || error.message}`);
    killTrackedChildren();
    process.send({ type: 'failed', message: error.message }, () => process.exit(1));
  }
});
