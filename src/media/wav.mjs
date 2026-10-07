const WAV_HEADER_MIN_BYTES = 44;

function readTag(view, offset) {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

// RIFF WAV 의 fmt 청크(샘플레이트·채널·byteRate)와 data 청크 크기로 길이를 구한다.
export function readWavInfo(bytes) {
  if (!bytes || bytes.byteLength < WAV_HEADER_MIN_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readTag(view, 0) !== 'RIFF' || readTag(view, 8) !== 'WAVE') return null;
  let offset = 12;
  let format = null;
  while (offset + 8 <= bytes.byteLength) {
    const tag = readTag(view, offset);
    const size = view.getUint32(offset + 4, true);
    const bodyOffset = offset + 8;
    if (tag === 'fmt ' && bodyOffset + 12 <= bytes.byteLength) {
      format = { channelCount: view.getUint16(bodyOffset + 2, true), sampleRate: view.getUint32(bodyOffset + 4, true), byteRate: view.getUint32(bodyOffset + 8, true) };
    }
    if (tag === 'data') {
      if (!format?.byteRate) return null;
      const dataBytes = Math.min(size, bytes.byteLength - bodyOffset);
      return { durationMs: Math.round((dataBytes / format.byteRate) * 1000), sampleRate: format.sampleRate, channelCount: format.channelCount };
    }
    offset = bodyOffset + size + (size % 2);
  }
  return null;
}
