import fs from 'node:fs';
import path from 'node:path';
import { runBinary } from '../media/ffmpeg.mjs';
import { readWavInfo } from '../media/wav.mjs';
import { resolveOutputAudioFormat, buildRenderChunkList } from './render-plan.mjs';

// AD wav 의 채널 수. 모노 AD 를 스테레오 출력에 Web Audio 처럼 넣으려고 쓴다. 제품 TTS 는 WAV 라, 채널 수를 읽지 못하면
// ffmpeg 기본 업믹스(-3dB)로 조용히 바뀌지 않게 거부한다. AD 하나는 몇 초짜리라 통째로 읽는다.
async function readAdChannelCountByRef(adPathByRef) {
  const channelCountByRef = new Map();
  for (const [adRef, adPath] of adPathByRef) {
    const channelCount = readWavInfo(await fs.promises.readFile(adPath))?.channelCount;
    if (!(channelCount > 0)) throw new Error(`AD 음성이 WAV 가 아니라 채널 수를 읽지 못했다: ${adPath}`);
    channelCountByRef.set(adRef, channelCount);
  }
  return channelCountByRef;
}

// 청크마다 WAV(f32)로 렌더하고 concat 으로 이어 한 번만 mp3 로 인코딩한다. 원본 샘플레이트·채널을 mp3 가 받는 범위에서 지키고 192kbps 로 낸다.
// 청크 WAV 는 몇 시간짜리 영상이면 4GB 를 넘을 수 있어 RF64 를 허용한다.
export async function renderOutputMp3({ sourcePath, hasSourceAudio, pieceList, adPathByRef, outPath, workDir, sampleRate, channelCount, ffmpegPath, bitrate = '192k' }) {
  const format = resolveOutputAudioFormat({ sampleRate: sampleRate ?? 48000, channelCount: channelCount ?? 2 });
  const chunkList = buildRenderChunkList({
    pieceList, sourcePath, hasSourceAudio, adPathByRef, sampleRate: format.sampleRate, channelLayout: format.channelLayout,
    adChannelCountByRef: await readAdChannelCountByRef(adPathByRef),
  });
  if (!chunkList.length) throw new Error('합성할 재생 조각이 없다');
  const tempPathList = [];
  try {
    const chunkPathList = [];
    for (const [index, chunk] of chunkList.entries()) {
      const scriptPath = path.join(workDir, `render-${index}.filter`);
      const chunkPath = path.resolve(workDir, `render-${index}.wav`);
      tempPathList.push(scriptPath, chunkPath);
      await fs.promises.writeFile(scriptPath, chunk.filterScript);
      // -filter_complex_script 는 ffmpeg 5.1–8.0 이 모두 읽는다. 7.0 에 생긴 -/filter_complex 는 6.x 에 없다(8.0 은 폐기 예정 경고만 낸다).
      await runBinary({
        binaryPath: ffmpegPath,
        argList: ['-v', 'error', '-y', ...chunk.inputArgList, '-filter_complex_script', scriptPath, '-map', '[out]', '-c:a', 'pcm_f32le', '-rf64', 'auto', chunkPath],
      });
      chunkPathList.push(chunkPath);
    }
    const listPath = path.join(workDir, 'render-list.txt');
    tempPathList.push(listPath);
    await fs.promises.writeFile(listPath, chunkPathList.map((chunkPath) => `file '${chunkPath.replaceAll("'", "'\\''")}'`).join('\n'));
    await runBinary({
      binaryPath: ffmpegPath,
      argList: ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:a', 'libmp3lame', '-b:a', bitrate, '-ar', String(format.sampleRate), '-ac', String(format.channelCount), outPath],
    });
    const totalSampleCount = chunkList.reduce((sum, chunk) => sum + chunk.sampleCount, 0);
    return { durationMs: Math.round((totalSampleCount * 1000) / format.sampleRate) };
  } finally {
    await Promise.all(tempPathList.map((tempPath) => fs.promises.rm(tempPath, { force: true })));
  }
}
