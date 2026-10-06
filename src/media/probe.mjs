import { runBinary } from './ffmpeg.mjs';

export async function probeVideo({ filePath, ffprobePath }) {
  const output = await runBinary({
    binaryPath: ffprobePath,
    argList: ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,sample_rate,channels', '-of', 'json', filePath],
  });
  const json = JSON.parse(output.toString('utf8'));
  const streamList = json.streams || [];
  const videoStream = streamList.find((stream) => stream.codec_type === 'video');
  const audioStream = streamList.find((stream) => stream.codec_type === 'audio');
  const durationMs = Math.round(Number(json.format?.duration) * 1000);
  if (!videoStream) throw new Error(`영상 스트림이 없다: ${filePath}`);
  if (!(durationMs > 0)) throw new Error(`영상 길이를 읽지 못했다: ${filePath}`);
  return {
    durationMs, width: Number(videoStream.width), height: Number(videoStream.height),
    hasAudio: Boolean(audioStream),
    audioSampleRate: audioStream ? Number(audioStream.sample_rate) : null,
    audioChannelCount: audioStream ? Number(audioStream.channels) : null,
  };
}
