import { ALIGN_TO_VIDEO_TIME_FILTER, runBinary } from './ffmpeg.mjs';
import { mapWithConcurrency } from '../util/map-with-concurrency.mjs';

// MediaRecorder(audio/webm;codecs=opus) 조각 대신 ffmpeg 로 같은 형식을 만든다. 입력 -ss 는 영상 시각 기준이다.
// 조각 안에서 오디오가 늦게 시작하면 MediaRecorder 처럼 그 앞을 무음으로 채운다. 채우지 않으면 webm 이 오디오 첫
// 표본부터 시작해서, 타임스탬프를 보지 않는 디코더가 말을 조각 앞쪽으로 당겨 읽는다.
export function buildSegmentEncodeArgList({ filePath, startMs, endMs }) {
  return [
    '-v', 'error', '-ss', (startMs / 1000).toFixed(3), '-t', ((endMs - startMs) / 1000).toFixed(3), '-i', filePath,
    '-vn', '-map', '0:a:0', '-af', ALIGN_TO_VIDEO_TIME_FILTER, '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '64k', '-f', 'webm', 'pipe:1',
  ];
}

export async function encodeVoicedSegmentList({ filePath, segmentList, ffmpegPath, concurrency = 4 }) {
  const voicedList = segmentList.filter((segment) => segment.isVoiced);
  const bufferList = await mapWithConcurrency({
    itemList: voicedList, concurrency,
    run: (segment) => runBinary({ binaryPath: ffmpegPath, argList: buildSegmentEncodeArgList({ filePath, ...segment }) }),
  });
  return new Map(voicedList.map((segment, index) => [segment.startMs, bufferList[index]]));
}
