import { runBinary } from './ffmpeg.mjs';

// ffprobe 의 화소 비율 "4:3" → 4/3. 없거나 읽지 못하면("0:1"·"N/A") 정사각 화소로 본다.
function parseSampleAspectRatio(text) {
  const [num, den] = String(text || '').split(':').map(Number);
  return num > 0 && den > 0 ? num / den : 1;
}

// 표시 행렬의 회전(도). 요즘 ffprobe 는 side_data 로, 옛 컨테이너 태그는 tags.rotate 로 준다.
function readRotation(videoStream) {
  const sideRotation = (videoStream.side_data_list || []).find((sideData) => Number.isFinite(Number(sideData?.rotation)))?.rotation;
  const rotation = Number(sideRotation ?? videoStream.tags?.rotate ?? 0);
  return Number.isFinite(rotation) ? rotation : 0;
}

// 화면 크기 두 가지. frameWidth·frameHeight 는 ffmpeg 필터가 받는 화소(자동 회전 뒤라 90°·270° 회전이면 저장 크기의 가로·세로가 바뀐다)로
// crop 이 이 화소를 자른다. displayWidth·displayHeight 는 제품 <video> 의 videoWidth·videoHeight 에 해당하는 표시 크기다 — Chromium 은
// 정사각이 아닌 화소를 펴서(넓은 화소는 가로를, 좁은 화소는 세로를 늘려 반올림) 회전까지 반영한다. 판정용 JPEG 의 긴 변 상한은 표시 크기로 정한다.
export function resolveFrameGeometry({ width, height, rotation = 0, sampleAspectRatio = 1 }) {
  const isQuarterTurn = Math.abs(Math.round(rotation)) % 180 === 90;
  const naturalWidth = sampleAspectRatio > 1 ? Math.round(width * sampleAspectRatio) : width;
  const naturalHeight = sampleAspectRatio < 1 ? Math.round(height / sampleAspectRatio) : height;
  return isQuarterTurn
    ? { frameWidth: height, frameHeight: width, displayWidth: naturalHeight, displayHeight: naturalWidth }
    : { frameWidth: width, frameHeight: height, displayWidth: naturalWidth, displayHeight: naturalHeight };
}

export async function probeVideo({ filePath, ffprobePath }) {
  const output = await runBinary({
    binaryPath: ffprobePath,
    argList: [
      '-v', 'error', '-show_entries',
      'format=duration:stream=codec_type,width,height,sample_aspect_ratio,sample_rate,channels:stream_side_data=rotation:stream_tags=rotate',
      '-of', 'json', filePath,
    ],
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
  const width = Number(videoStream.width);
  const height = Number(videoStream.height);
  const rotation = readRotation(videoStream);
  const sampleAspectRatio = parseSampleAspectRatio(videoStream.sample_aspect_ratio);
  // width·height 는 저장 크기 그대로다(결과 JSON video 에 적는 값).
  return {
    durationMs, width, height, rotation, sampleAspectRatio,
    ...resolveFrameGeometry({ width, height, rotation, sampleAspectRatio }),
    hasAudio: Boolean(audioStream),
    audioSampleRate: audioStream ? Number(audioStream.sample_rate) : null,
    audioChannelCount: audioStream ? Number(audioStream.channels) : null,
  };
}
