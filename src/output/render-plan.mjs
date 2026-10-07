import { PIECE_KIND_MAP } from '../session/playback-recorder.mjs';
import { ALIGN_TO_VIDEO_TIME_FILTER } from '../media/ffmpeg.mjs';

const MP3_SAMPLE_RATE_LIST = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
const RATE_EPSILON = 0.001;
// ffmpeg atempo 가 받는 배속. 제품 배속은 1 이상 따라잡기뿐이라 이 밖은 원음 길이 0 같은 연결 코드의 잘못이다.
const ATEMPO_MIN_RATE = 0.5;
const ATEMPO_MAX_RATE = 100;
// Web Audio 는 모노 AD 를 스테레오 출력의 두 채널에 그대로 복사한다(speakers 업믹스). ffmpeg 기본 업믹스는 채널마다 -3dB 라 따로 정한다.
const MONO_TO_STEREO_FILTER = 'pan=stereo|c0=c0|c1=c0';

// 원본 샘플레이트·채널을 지키되 libmp3lame 이 받는 범위(≤48kHz, ≤2채널)로 맞춘다.
export function resolveOutputAudioFormat({ sampleRate, channelCount }) {
  const outSampleRate = MP3_SAMPLE_RATE_LIST.includes(sampleRate) ? sampleRate : 48000;
  const outChannelCount = channelCount === 1 ? 1 : 2;
  return { sampleRate: outSampleRate, channelCount: outChannelCount, channelLayout: outChannelCount === 1 ? 'mono' : 'stereo' };
}

const toSec = (ms) => (ms / 1000).toFixed(6);
const toSampleIndex = (ms, sampleRate) => Math.round((ms * sampleRate) / 1000);

// 조각 길이를 출력 시각 경계의 표본 위치 차로 잰다. 조각마다 길이를 반올림하면 오차가 쌓여 뒤쪽 AD 위치가 밀린다.
export function computePieceSampleCount({ piece, sampleRate }) {
  return toSampleIndex(piece.outEndMs, sampleRate) - toSampleIndex(piece.outStartMs, sampleRate);
}

// 조각마다 출력 길이를 표본 단위로 맞춘다(apad+atrim). atempo 의 몇 ms 오차가 쌓여 AD 위치가 밀리지 않게 한다.
// 표본 수가 0 이면 apad 가 끝없이 채우므로 받지 않는다.
export function buildPieceFilter({ piece, inputLabel = null, outputLabel, seekMs = 0, sampleRate, channelLayout, adChannelCount = null }) {
  const sampleCount = computePieceSampleCount({ piece, sampleRate });
  if (sampleCount < 1) throw new Error(`표본이 없는 조각은 합성하지 않는다: ${piece.outStartMs}–${piece.outEndMs}ms`);
  const fit = `aresample=${sampleRate},aformat=sample_fmts=fltp:channel_layouts=${channelLayout},apad=whole_len=${sampleCount},atrim=end_sample=${sampleCount},asetpts=PTS-STARTPTS`;
  if (piece.kind === PIECE_KIND_MAP.silence || !inputLabel) {
    return `anullsrc=r=${sampleRate}:cl=${channelLayout},atrim=end_sample=${sampleCount},asetpts=PTS-STARTPTS[${outputLabel}]`;
  }
  if (piece.kind === PIECE_KIND_MAP.ad) {
    const upmix = channelLayout === 'stereo' && adChannelCount === 1 ? `${MONO_TO_STEREO_FILTER},` : '';
    return `[${inputLabel}]asetpts=PTS-STARTPTS,${upmix}${fit}[${outputLabel}]`;
  }
  const rate = (piece.srcEndMs - piece.srcStartMs) / (piece.outEndMs - piece.outStartMs);
  const isTempoNeeded = Math.abs(rate - 1) >= RATE_EPSILON;
  if (isTempoNeeded && !(rate >= ATEMPO_MIN_RATE && rate <= ATEMPO_MAX_RATE)) {
    throw new Error(`원음 조각 배속 ${rate.toFixed(6)} 이 atempo 범위(${ATEMPO_MIN_RATE}–${ATEMPO_MAX_RATE}) 밖이다: `
      + `출력 ${piece.outStartMs}–${piece.outEndMs}ms, 원음 ${piece.srcStartMs}–${piece.srcEndMs}ms`);
  }
  const tempo = isTempoNeeded ? `,atempo=${rate.toFixed(6)}` : '';
  return `[${inputLabel}]atrim=start=${toSec(piece.srcStartMs - seekMs)}:end=${toSec(piece.srcEndMs - seekMs)},asetpts=PTS-STARTPTS${tempo},${fit}[${outputLabel}]`;
}

// 긴 영상은 조각이 수천 개가 될 수 있어 청크마다 따로 렌더한다. 원음은 청크 첫 조각 앞에서 열어(-ss) 처음부터 다시 디코드하지 않는다.
// 원음 시각은 영상(컨테이너) 시각이라, 오디오가 늦게 시작하거나 빈 구간은 나누기 전에 무음으로 채워 표본 위치를 맞춘다.
export function buildRenderChunkList({
  pieceList, sourcePath, hasSourceAudio, adPathByRef, sampleRate, channelLayout, maxPieceCount = 100, adChannelCountByRef = new Map(),
}) {
  const audiblePieceList = pieceList.filter((piece) => computePieceSampleCount({ piece, sampleRate }) > 0);
  const chunkList = [];
  for (let start = 0; start < audiblePieceList.length; start += maxPieceCount) {
    const chunkPieceList = audiblePieceList.slice(start, start + maxPieceCount);
    const inputArgList = [];
    const lineList = [];
    const sourcePieceList = chunkPieceList.filter((piece) => piece.kind === PIECE_KIND_MAP.source);
    const isSourceUsed = hasSourceAudio && sourcePieceList.length > 0;
    // -ss 문자열이 seekMs 를 그대로 나타내도록 ms 단위로 내린다. 조각 atrim 은 이 값에서 잰다.
    const seekMs = isSourceUsed ? Math.floor(Math.min(...sourcePieceList.map((piece) => piece.srcStartMs))) : 0;
    let inputIndex = 0;
    let sourceLabelIndex = 0;
    if (isSourceUsed) {
      inputArgList.push('-ss', (seekMs / 1000).toFixed(3), '-i', sourcePath);
      const labelList = sourcePieceList.map((_, index) => `[s${index}]`).join('');
      const split = sourcePieceList.length === 1 ? '' : `,asplit=${sourcePieceList.length}`;
      lineList.push(`[0:a]${ALIGN_TO_VIDEO_TIME_FILTER}${split}${labelList}`);
      inputIndex = 1;
    }
    chunkPieceList.forEach((piece, index) => {
      const outputLabel = `p${index}`;
      if (piece.kind === PIECE_KIND_MAP.source) {
        const inputLabel = isSourceUsed ? `s${sourceLabelIndex}` : null;
        sourceLabelIndex += 1;
        lineList.push(buildPieceFilter({ piece, inputLabel, outputLabel, seekMs, sampleRate, channelLayout }));
        return;
      }
      if (piece.kind === PIECE_KIND_MAP.ad) {
        const adPath = adPathByRef.get(piece.adRef);
        if (!adPath) throw new Error(`AD 음성 파일이 없다: ${piece.adRef}`);
        inputArgList.push('-i', adPath);
        lineList.push(buildPieceFilter({
          piece, inputLabel: `${inputIndex}:a`, outputLabel, sampleRate, channelLayout, adChannelCount: adChannelCountByRef.get(piece.adRef) ?? null,
        }));
        inputIndex += 1;
        return;
      }
      lineList.push(buildPieceFilter({ piece, outputLabel, sampleRate, channelLayout }));
    });
    lineList.push(`${chunkPieceList.map((_, index) => `[p${index}]`).join('')}concat=n=${chunkPieceList.length}:v=0:a=1[out]`);
    const outDurationMs = chunkPieceList.reduce((sum, piece) => sum + (piece.outEndMs - piece.outStartMs), 0);
    const sampleCount = chunkPieceList.reduce((sum, piece) => sum + computePieceSampleCount({ piece, sampleRate }), 0);
    chunkList.push({ inputArgList, filterScript: lineList.join(';\n'), outDurationMs: Math.round(outDurationMs), sampleCount });
  }
  return chunkList;
}
