import { ALIGN_TO_VIDEO_TIME_FILTER, spawnTracked } from './ffmpeg.mjs';
import { METER_FFT_SIZE, METER_SAMPLE_RATE, VAD_SAMPLE_MS } from '../session/renderer-constants.mjs';

const toMeterByte = (sample) => Math.min(255, Math.max(0, Math.floor(128 * (1 + sample))));

// AnalyserNode.getByteTimeDomainData 처럼 마지막 windowSize 표본을 ⌊128(1+x)⌋ 바이트로 바꿔 RMS 를 낸다.
// 아직 표본이 모자라면 앞부분은 무음(128)이다.
export function computeMeterLevel({ sampleList, endIndex, windowSize = METER_FFT_SIZE }) {
  let squareSum = 0;
  for (let offset = 0; offset < windowSize; offset += 1) {
    const index = endIndex - windowSize + offset;
    const sample = index >= 0 && index < sampleList.length ? sampleList[index] : 0;
    squareSum += (toMeterByte(sample) - 128) ** 2;
  }
  return Math.sqrt(squareSum / windowSize) / 128;
}

const tickEndIndex = ({ tick, tickMs, sampleRate }) => Math.round((tick * tickMs * sampleRate) / 1000);

export function computeMeterLevelList({ sampleList, sampleRate = METER_SAMPLE_RATE, tickMs = VAD_SAMPLE_MS }) {
  const tickCount = Math.floor((sampleList.length * 1000) / sampleRate / tickMs);
  const levelList = new Float32Array(tickCount);
  for (let tick = 1; tick <= tickCount; tick += 1) {
    levelList[tick - 1] = computeMeterLevel({ sampleList, endIndex: tickEndIndex({ tick, tickMs, sampleRate }) });
  }
  return levelList;
}

// 긴 영상도 PCM 전체를 들고 있지 않도록 마지막 창만 고리 버퍼로 남기며 tick 마다 레벨을 낸다.
export function createMeterLevelAccumulator({ sampleRate = METER_SAMPLE_RATE, tickMs = VAD_SAMPLE_MS, windowSize = METER_FFT_SIZE } = {}) {
  const ring = new Float32Array(windowSize);
  const levelList = [];
  let sampleCount = 0;
  let nextTick = 1;
  function emitLevel() {
    let squareSum = 0;
    for (let offset = 0; offset < windowSize; offset += 1) {
      const absoluteIndex = sampleCount - windowSize + offset;
      const sample = absoluteIndex >= 0 ? ring[absoluteIndex % windowSize] : 0;
      squareSum += (toMeterByte(sample) - 128) ** 2;
    }
    levelList.push(Math.sqrt(squareSum / windowSize) / 128);
  }
  return {
    push(chunk) {
      for (let i = 0; i < chunk.length; i += 1) {
        ring[sampleCount % windowSize] = chunk[i];
        sampleCount += 1;
        if (sampleCount === tickEndIndex({ tick: nextTick, tickMs, sampleRate })) {
          emitLevel();
          nextTick += 1;
        }
      }
    },
    finish: () => Float32Array.from(levelList),
  };
}

// Web Audio "speakers" 모노 다운믹스: 스테레오 0.5(L+R), 5.1 √½(L+R) + C + ½(SL+SR)(LFE 제외).
// 그 밖의 채널 수는 ffmpeg 기본 다운믹스(-ac 1)에 맡긴다.
const DOWNMIX_FILTER_MAP = {
  2: 'pan=mono|c0=0.5*c0+0.5*c1',
  6: 'pan=mono|c0=0.7071068*c0+0.7071068*c1+c2+0.5*c4+0.5*c5',
};

// 오디오가 늦게 시작한 앞부분과 중간 빈 곳을 무음으로 채워 표본 위치 = 영상 시각이 되게 한 뒤 모노로 줄인다.
function buildMeterDecodeArgList(channelCount) {
  const downmixFilter = DOWNMIX_FILTER_MAP[channelCount];
  if (channelCount === 1) return ['-af', ALIGN_TO_VIDEO_TIME_FILTER];
  if (downmixFilter) return ['-af', `${ALIGN_TO_VIDEO_TIME_FILTER},${downmixFilter}`];
  return ['-af', ALIGN_TO_VIDEO_TIME_FILTER, '-ac', '1'];
}

export async function decodeMeterLevelList({ filePath, probe, ffmpegPath }) {
  if (!probe.hasAudio) return new Float32Array(Math.floor(probe.durationMs / VAD_SAMPLE_MS));
  const child = spawnTracked(ffmpegPath, [
    '-v', 'error', '-i', filePath, '-vn', '-map', '0:a:0', ...buildMeterDecodeArgList(probe.audioChannelCount),
    '-ar', String(METER_SAMPLE_RATE), '-f', 'f32le', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  // 실행 파일을 띄우지 못하면 ChildProcess 가 'error' 를 내는데, 듣는 곳이 없으면 프로세스가 죽는다. 받아 두었다가 거부한다.
  let spawnError = null;
  child.once('error', (error) => { spawnError = error; });
  const accumulator = createMeterLevelAccumulator({});
  let carry = Buffer.alloc(0);
  const stderrList = [];
  child.stderr.on('data', (chunk) => stderrList.push(chunk));
  for await (const chunk of child.stdout) {
    const merged = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const usableBytes = merged.length - (merged.length % 4);
    const aligned = Buffer.from(merged.subarray(0, usableBytes));
    accumulator.push(new Float32Array(aligned.buffer, aligned.byteOffset, usableBytes / 4));
    carry = merged.subarray(usableBytes);
  }
  const exitCode = await new Promise((resolve) => { if (child.exitCode !== null) resolve(child.exitCode); else child.once('close', resolve); });
  if (spawnError) throw spawnError;
  if (exitCode !== 0) throw new Error(`오디오 디코드 실패: ${Buffer.concat(stderrList).toString('utf8').slice(-400)}`);
  return accumulator.finish();
}

// 영상 k×tickMs 시각의 레벨. 제품의 100ms tick 은 세션 시작부터 같은 격자로 돈다.
export function readLevelAt({ levelList, timeMs, tickMs = VAD_SAMPLE_MS }) {
  const tick = Math.round(timeMs / tickMs);
  if (tick < 1 || tick > levelList.length) return 0;
  return levelList[tick - 1];
}
