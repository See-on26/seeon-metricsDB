import path from 'node:path';
import { runBinary } from '../../src/media/ffmpeg.mjs';

const CHANNEL_LAYOUT_MAP = { 1: 'mono', 2: 'stereo', 6: '5.1' };

// lavfi 로 색 슬라이드 + 수식 오디오 영상을 만든다. 쉼표가 든 수식은 작은따옴표로 감싸야 필터 구분자로 읽히지 않는다.
// audioExpr 가 문자열이면 모든 채널에 그대로 복사하고, 배열이면 채널 순서(5.1 은 FL FR FC LFE SL SR)대로 하나씩 쓴다.
// aformat 업믹스를 쓰지 않는 것은 모노를 채널마다 -3dB 로 나눠 수식 진폭이 어긋나기 때문이다.
// audioStartSec 를 주면 오디오 stream 이 컨테이너 시각 그만큼 늦게 시작한다(AAC 지연 때문에 start_time 은 약 21ms 이르다).
export async function createTestClip({
  dirPath, fileName = 'clip.mp4', width = 320, height = 180, colorTimeline = [['black', 4]],
  audioExpr = '0', hasAudio = true, box = null, audioChannelCount = 2, audioSampleRate = 48000, audioStartSec = 0,
}) {
  const durationSec = colorTimeline.reduce((sum, [, sec]) => sum + sec, 0);
  const argList = ['-v', 'error', '-y'];
  colorTimeline.forEach(([color, sec]) => argList.push('-f', 'lavfi', '-i', `color=c=${color}:s=${width}x${height}:r=25:d=${sec}`));
  let videoChain = `${colorTimeline.map((_, index) => `[${index}:v]`).join('')}concat=n=${colorTimeline.length}:v=1:a=0`;
  if (box) videoChain += `,drawbox=x=${box.x}:y=${box.y}:w=${box.w}:h=${box.h}:color=white:t=fill:enable='between(t,${box.fromSec},${box.toSec})'`;
  const filterList = [`${videoChain},format=yuv420p[v]`];
  if (hasAudio) {
    const channelLayout = CHANNEL_LAYOUT_MAP[audioChannelCount];
    const exprList = Array.isArray(audioExpr) ? audioExpr : Array.from({ length: audioChannelCount }, () => audioExpr);
    if (!channelLayout || exprList.length !== audioChannelCount) {
      throw new Error(`지원하지 않는 오디오 채널 구성: ${audioChannelCount}채널, 수식 ${exprList.length}개`);
    }
    argList.push('-f', 'lavfi', '-i', `aevalsrc='${exprList.join('|')}':c=${channelLayout}:s=${audioSampleRate}:d=${durationSec}`);
    filterList.push(`[${colorTimeline.length}:a]${audioStartSec > 0 ? `asetpts=PTS+${audioStartSec}/TB` : 'anull'}[a]`);
  }
  const filePath = path.join(dirPath, fileName);
  argList.push('-filter_complex', filterList.join(';'), '-map', '[v]');
  if (hasAudio) argList.push('-map', '[a]', '-c:a', 'aac', '-b:a', '128k');
  argList.push('-c:v', 'libx264', '-preset', 'veryfast', '-t', String(durationSec), filePath);
  await runBinary({ binaryPath: process.env.SEEON_FACTORY_FFMPEG || 'ffmpeg', argList });
  return filePath;
}

// JPEG SOF0~SOF2 표지에서 크기를 읽는다.
export function readJpegSize(buffer) {
  for (let offset = 2; offset + 9 < buffer.length;) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc2) return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    offset += 2 + length;
  }
  return null;
}
