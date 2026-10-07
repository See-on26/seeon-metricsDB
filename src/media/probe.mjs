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
  // MediaRecorder 처럼 길이를 모르고 쓴 webm 은 Duration 요소가 없다. 끝까지 읽어 길이를 짐작하지 않고, 다시 담아(-c copy)
  // 길이를 적는 방법을 알린다. 그런 파일은 탐색 색인(Cues)도 없어 -ss 로 여는 조각 인코딩·합성도 느리거나 어긋날 수 있다.
  if (!(durationMs > 0)) {
    throw new Error(`영상 길이를 읽지 못했다 — 컨테이너에 길이 정보가 없다(MediaRecorder 로 녹화한 webm 이면 `
      + `\`ffmpeg -i <입력> -c copy <출력>.webm\` 으로 다시 담으면 길이가 생긴다): ${filePath}`);
  }
  return {
    durationMs, width: Number(videoStream.width), height: Number(videoStream.height),
    hasAudio: Boolean(audioStream),
    audioSampleRate: audioStream ? Number(audioStream.sample_rate) : null,
    audioChannelCount: audioStream ? Number(audioStream.channels) : null,
  };
}
