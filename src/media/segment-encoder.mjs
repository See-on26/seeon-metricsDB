import { runBinary } from './ffmpeg.mjs';
import { buildAlignedMonoArgList } from './audio-levels.mjs';
import { mapWithConcurrency } from '../util/map-with-concurrency.mjs';

// MediaRecorder(audio/webm;codecs=opus) 조각 대신 ffmpeg 로 같은 형식을 만든다. 입력 -ss 는 영상 시각 기준이다.
// 조각 안에서 오디오가 늦게 시작하면 MediaRecorder 처럼 그 앞을 무음으로 채운다. 채우지 않으면 webm 이 오디오 첫
// 표본부터 시작해서, 타임스탬프를 보지 않는 디코더가 말을 조각 앞쪽으로 당겨 읽는다.
// 모노로는 레벨과 같은 다운믹스(스테레오 ½L+½R)로 줄인다. 제품은 원래 채널로 녹음하고 ASR 서버가 s16 모노로 바꿀 때
// 정규화해 ½L+½R 이 된다. ffmpeg 기본 -ac 1 은 부동소수로 디코드하는 입력(AAC 등)에서 √½(L+R) 로 키워, −3dBFS 를 넘는
// 봉우리가 ASR 서버의 s16 변환에서 잘린다.
export function buildSegmentEncodeArgList({ filePath, startMs, endMs, channelCount }) {
  if (!(Number.isInteger(channelCount) && channelCount > 0)) throw new Error(`조각 인코딩에 원본 오디오 채널 수가 필요하다: ${channelCount}`);
  return [
    '-v', 'error', '-ss', (startMs / 1000).toFixed(3), '-t', ((endMs - startMs) / 1000).toFixed(3), '-i', filePath,
    '-vn', '-map', '0:a:0', ...buildAlignedMonoArgList({ channelCount }), '-ar', '48000', '-c:a', 'libopus', '-b:a', '64k', '-f', 'webm', 'pipe:1',
  ];
}

export async function encodeVoicedSegmentList({ filePath, segmentList, channelCount, ffmpegPath, concurrency = 4 }) {
  const voicedList = segmentList.filter((segment) => segment.isVoiced);
  const bufferList = await mapWithConcurrency({
    itemList: voicedList, concurrency,
    run: (segment) => runBinary({ binaryPath: ffmpegPath, argList: buildSegmentEncodeArgList({ filePath, ...segment, channelCount }) }),
  });
  return new Map(voicedList.map((segment, index) => [segment.startMs, bufferList[index]]));
}
