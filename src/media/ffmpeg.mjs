import { spawn } from 'node:child_process';
import path from 'node:path';

const trackedChildSet = new Set();

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

export function runBinary({ binaryPath, argList, inputBuffer = null }) {
  return new Promise((resolve, reject) => {
    const child = spawnTracked(binaryPath, argList, { stdio: ['pipe', 'pipe', 'pipe'] });
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
