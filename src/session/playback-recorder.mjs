export const PIECE_KIND_MAP = { source: 'source', ad: 'ad', silence: 'silence' };

const RATE_EPSILON = 0.001;
// 배속 구간 사이에 낀 짧은 1배속 조각은 같은 따라잡기의 일부로 본다(라이브 끝 200ms 계단 때문에 생긴다).
const SHORT_NORMAL_PIECE_MS = 1000;
const MIN_GAP_MS = 0.5;

const readRate = (piece) => (piece.srcEndMs - piece.srcStartMs) / (piece.outEndMs - piece.outStartMs);
const isContiguousSource = (left, right) => left.kind === PIECE_KIND_MAP.source && right.kind === PIECE_KIND_MAP.source
  && Math.abs(left.outEndMs - right.outStartMs) < MIN_GAP_MS && Math.abs(left.srcEndMs - right.srcStartMs) < 1;

// 사용자가 듣는 출력의 순서표를 만든다. 원음 구간은 지연 재생 요소의 play·rate·pause·ended 로, AD 는 AudioContext 재생으로 연다·닫는다.
export function createPlaybackRecorder() {
  const rawPieceList = [];
  let openSource = null;
  let openAd = null;
  let originElapsedMs = null;

  function closeSource({ atElapsedMs, mediaMs }) {
    if (!openSource) return;
    if (atElapsedMs > openSource.atElapsedMs) {
      rawPieceList.push({ kind: PIECE_KIND_MAP.source, outStartElapsedMs: openSource.atElapsedMs, outEndElapsedMs: atElapsedMs, srcStartMs: openSource.mediaMs, srcEndMs: mediaMs });
    }
    openSource = null;
  }

  function handleElementChange({ kind, atElapsedMs, mediaMs }) {
    if (kind === 'play' || (kind === 'rate' && openSource)) {
      closeSource({ atElapsedMs, mediaMs });
      openSource = { atElapsedMs, mediaMs };
      if (originElapsedMs === null) originElapsedMs = atElapsedMs;
      return;
    }
    if (kind === 'pause' || kind === 'ended') closeSource({ atElapsedMs, mediaMs });
  }

  function handleAdStart({ adRef, atElapsedMs }) {
    if (originElapsedMs === null) originElapsedMs = atElapsedMs;
    openAd = { adRef, atElapsedMs };
  }

  function handleAdStop({ atElapsedMs }) {
    if (!openAd) return;
    rawPieceList.push({ kind: PIECE_KIND_MAP.ad, outStartElapsedMs: openAd.atElapsedMs, outEndElapsedMs: atElapsedMs, adRef: openAd.adRef });
    openAd = null;
  }

  function close({ atElapsedMs, mediaMs }) {
    closeSource({ atElapsedMs, mediaMs });
    handleAdStop({ atElapsedMs });
  }

  // 교차 모드에서 AD 와 원음은 겹치지 않는다. 겹치면 연결 코드의 잘못이라 바로 알린다.
  function getPieceList() {
    if (originElapsedMs === null) return [];
    const sortedList = [...rawPieceList].sort((left, right) => left.outStartElapsedMs - right.outStartElapsedMs);
    const pieceList = [];
    let cursorMs = 0;
    for (const raw of sortedList) {
      const outStartMs = raw.outStartElapsedMs - originElapsedMs;
      const outEndMs = raw.outEndElapsedMs - originElapsedMs;
      if (outStartMs < cursorMs - MIN_GAP_MS) throw new Error(`재생 구간이 겹친다: ${outStartMs}ms < ${cursorMs}ms`);
      if (outStartMs - cursorMs >= MIN_GAP_MS) pieceList.push({ kind: PIECE_KIND_MAP.silence, outStartMs: cursorMs, outEndMs: outStartMs });
      const { outStartElapsedMs, outEndElapsedMs, ...rest } = raw;
      pieceList.push({ ...rest, outStartMs, outEndMs });
      cursorMs = outEndMs;
    }
    return pieceList;
  }

  return { handleElementChange, handleAdStart, handleAdStop, close, getPieceList };
}

// 합성 조각 수를 줄인다: 이어진 원음 조각을 1배속끼리·배속끼리 합친다. 출력 길이와 AD 위치는 그대로다.
export function compactPieceList(pieceList) {
  const classList = pieceList.map((piece) => (piece.kind === PIECE_KIND_MAP.source ? (readRate(piece) > 1 + RATE_EPSILON ? 'catchup' : 'normal') : null));
  for (let i = 1; i < pieceList.length - 1; i += 1) {
    const piece = pieceList[i];
    const isShortNormal = classList[i] === 'normal' && piece.outEndMs - piece.outStartMs < SHORT_NORMAL_PIECE_MS;
    if (isShortNormal && classList[i - 1] === 'catchup' && classList[i + 1] === 'catchup'
      && isContiguousSource(pieceList[i - 1], piece) && isContiguousSource(piece, pieceList[i + 1])) classList[i] = 'catchup';
  }
  const compactedList = [];
  pieceList.forEach((piece, index) => {
    const previous = compactedList[compactedList.length - 1];
    const canMerge = previous && previous.classKind === classList[index] && classList[index] !== null && isContiguousSource(previous, piece);
    if (canMerge) {
      previous.outEndMs = piece.outEndMs;
      previous.srcEndMs = piece.srcEndMs;
      return;
    }
    compactedList.push({ ...piece, classKind: classList[index] });
  });
  return compactedList.map(({ classKind, ...piece }) => piece);
}

export function summarizeTimeline(pieceList) {
  const sumBy = (kind, read) => pieceList.filter((piece) => piece.kind === kind).reduce((sum, piece) => sum + read(piece), 0);
  const outLength = (piece) => piece.outEndMs - piece.outStartMs;
  const sourceMediaMs = sumBy(PIECE_KIND_MAP.source, (piece) => piece.srcEndMs - piece.srcStartMs);
  const sourceOutMs = sumBy(PIECE_KIND_MAP.source, outLength);
  return {
    outputDurationMs: pieceList.length ? pieceList[pieceList.length - 1].outEndMs : 0,
    sourceMediaMs,
    adTotalMs: sumBy(PIECE_KIND_MAP.ad, outLength),
    silenceTotalMs: sumBy(PIECE_KIND_MAP.silence, outLength),
    recoveredMs: sourceMediaMs - sourceOutMs,
  };
}
