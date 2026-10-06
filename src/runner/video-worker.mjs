import os from 'node:os';
import { runVideoJob } from './run-video-job.mjs';
import { killTrackedChildren } from '../media/ffmpeg.mjs';

// 터미널 Ctrl-C 는 프로세스 그룹 전체(CLI·워커·ffmpeg)에 SIGINT 를 보낸다. 워커는 그 SIGINT 로 죽지 않는다.
// 멈춤은 부모(워커 풀)가 SIGTERM 으로 보내고, 부모가 그 결과를 영상마다 거둬 manifest 에 중단으로 남긴다.
process.on('SIGINT', () => {});

// 워커 풀이 시간 초과·중단 때 SIGTERM 을, 터미널이 닫히면 SIGHUP 을 보낸다. 띄운 ffmpeg 가 고아로 남지 않게 정리하고 끝낸다(128 + 신호 번호).
for (const signalName of ['SIGTERM', 'SIGHUP']) {
  process.once(signalName, () => {
    killTrackedChildren();
    process.exit(128 + os.constants.signals[signalName]);
  });
}

// 부모가 죽어(SIGKILL·크래시) IPC 가 끊기면 결과를 받을 곳이 없다. 고아로 GPU·출력 폴더를 계속 쓰지 않게 정리하고 끝낸다.
process.once('disconnect', () => {
  console.error('[factory] 부모 프로세스와 연결이 끊겼다 — 띄운 ffmpeg 를 정리하고 끝낸다');
  killTrackedChildren();
  process.exit(1);
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
