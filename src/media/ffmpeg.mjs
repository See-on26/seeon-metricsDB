import { spawn } from 'node:child_process';
import path from 'node:path';

const trackedChildSet = new Set();

// 영상 시각은 컨테이너 시작(format start_time)부터 잰 재생 위치다. 제품 실험실의 video.currentTime, ffmpeg 입력 -ss,
// probe 의 durationMs 가 모두 이 기준이다. 오디오 stream 이 늦게 시작하거나 중간에 비면 디코드한 표본열은 그 구간을
// 건너뛰어 표본 위치가 영상 시각보다 앞당겨진다. 이 필터는 그 구간을 무음으로 채워 첫 표본을 출력 시각 0 에 맞춘다.
export const ALIGN_TO_VIDEO_TIME_FILTER = 'aresample=async=1:first_pts=0';

export function resolveFfmpegPaths({ env = process.env } = {}) {
  return { ffmpegPath: env.SEEON_FACTORY_FFMPEG || 'ffmpeg', ffprobePath: env.SEEON_FACTORY_FFPROBE || 'ffprobe' };
}

// 워커가 실패로 끝날 때 ffmpeg 가 남지 않게 띄운 자식 프로세스를 기억한다.
export function spawnTracked(binaryPath, argList, options = {}) {
  const child = spawn(binaryPath, argList, options);
  trackedChildSet.add(child);
  child.once('close', () => trackedChildSet.delete(child));
  return child;
}

export function killTrackedChildren() {
  for (const child of trackedChildSet) child.kill('SIGKILL');
  trackedChildSet.clear();
}

// signal 을 주면 중단할 때 그 프로세스만 SIGKILL 로 죽이고 AbortError 로 거부한다(멈춘 ffmpeg 를 실제 시간 상한으로 끊을 때).
export function runBinary({ binaryPath, argList, inputBuffer = null, signal = null }) {
  return new Promise((resolve, reject) => {
    const abortOption = signal ? { signal, killSignal: 'SIGKILL' } : {};
    const child = spawnTracked(binaryPath, argList, { stdio: ['pipe', 'pipe', 'pipe'], ...abortOption });
    const stdoutList = [];
    const stderrList = [];
    child.stdout.on('data', (chunk) => stdoutList.push(chunk));
    child.stderr.on('data', (chunk) => stderrList.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) { resolve(Buffer.concat(stdoutList)); return; }
      reject(new Error(`${path.basename(binaryPath)} 종료 코드 ${code}: ${Buffer.concat(stderrList).toString('utf8').slice(-600)}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(inputBuffer || undefined);
  });
}
