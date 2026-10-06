import { runBinary } from './ffmpeg.mjs';
import { mapWithConcurrency } from '../util/map-with-concurrency.mjs';

// MediaRecorder(audio/webm;codecs=opus) 조각 대신 ffmpeg 로 같은 형식을 만든다.
export function buildSegmentEncodeArgList({ filePath, startMs, endMs }) {
  return [
    '-v', 'error', '-ss', (startMs / 1000).toFixed(3), '-t', ((endMs - startMs) / 1000).toFixed(3), '-i', filePath,
    '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '64k', '-f', 'webm', 'pipe:1',
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
