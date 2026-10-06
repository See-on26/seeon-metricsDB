import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVirtualClock } from '../src/clock/virtual-clock.mjs';
import { FakeMediaElement, FakeDelaySource, FakeAudioContext, createFakeCaptureStream } from '../src/session/fake-media.mjs';
import { createPlaybackRecorder, compactPieceList, summarizeTimeline } from '../src/session/playback-recorder.mjs';
import {
  DelayBuffer, NarrationScheduler, CaptionNarrator, NarrationHoldGate, MODE_MAP, getModePolicy, getCatchupRateRange,
} from '../src/product/core-modules.mjs';
import { createToneWav } from './helpers/mock-services.mjs';

function buildChain({ mediaDurationMs }) {
  const clock = createVirtualClock({ startWallMs: 1_800_000_000_000 });
  const policy = getModePolicy({ mode: MODE_MAP.delayed });
  const recorder = createPlaybackRecorder();
  const delaySource = new FakeDelaySource({
    clock, getVideoTimeMs: () => clock.elapsedMs(), mediaDurationMs, targetDelayMs: policy.delayMs,
    onElementChange: (event) => recorder.handleElementChange(event),
  });
  const intervalDeps = { setTimer: (fn, ms) => clock.setInterval(fn, ms), clearTimer: (handle) => clock.clearInterval(handle) };
  const delayBuffer = new DelayBuffer({ source: delaySource, targetDelayMs: policy.delayMs, rateMin: policy.rateMin, rateMax: policy.rateMax, ...intervalDeps });
  const box = {};
  box.narrator = new CaptionNarrator({
    getLiveVideo: () => delayBuffer.delayedVideo,
    getRateRange: () => getCatchupRateRange({ mode: MODE_MAP.delayed }),
    isCatchupDelegated: () => true,
    now: () => clock.nowPerf(),
    createAudioContext: () => new FakeAudioContext({
      clock,
      onSourceStart: ({ atElapsedMs, durationMs }) => recorder.handleAdStart({ adRef: box.narrator.currentEntry?.captionSeq ?? null, atElapsedMs, durationMs }),
      onSourceStop: ({ atElapsedMs }) => recorder.handleAdStop({ atElapsedMs }),
    }),
  });
  const narrationGate = new NarrationHoldGate({ deliver: (entry) => box.narrator.queueCaption(entry) });
  const narrationScheduler = new NarrationScheduler({
    getPlaybackTimeMs: () => delayBuffer.getDelayedTimeMs(),
    onDue: ({ entry }) => narrationGate.submit({ ...entry, dueAt: clock.nowPerf() }),
    ...intervalDeps,
  });
  delayBuffer.start();
  narrationScheduler.start();
  box.narrator.start(createFakeCaptureStream());
  clock.setTimeout(() => delaySource.enterTailMode(), mediaDurationMs);
  return { clock, recorder, delaySource, delayBuffer, narrationScheduler, narrator: box.narrator };
}

function buildEntry({ captionSeq, durationMs, eventTimeMs }) {
  const wav = createToneWav({ durationMs });
  return {
    wavArrayBuffer: wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength),
    narrationClass: 'deixis', slideLabel: null, source: 'deixis', text: `해설 ${captionSeq}`, ts: captionSeq, eventTimeMs, captionSeq,
  };
}

async function runToEnd(chain) {
  await chain.clock.runUntil({ isDone: () => chain.delayBuffer.delayedVideo?.ended === true && !chain.narrator.currentEntry });
  chain.recorder.close({ atElapsedMs: chain.clock.elapsedMs(), mediaMs: chain.delayBuffer.getDelayedTimeMs() });
  return compactPieceList(chain.recorder.getPieceList());
}

test('해설이 없으면 10초를 채운 뒤 1배속으로 틀고, 영상이 끝나도 라이브 끝이 계속 흘러 밀린 10초를 1배속으로 마저 튼다', async () => {
  const pieceList = await runToEnd(buildChain({ mediaDurationMs: 30000 }));
  assert.equal(pieceList.length, 1);
  assert.deepEqual([pieceList[0].outStartMs, Math.round(pieceList[0].outEndMs), pieceList[0].srcStartMs, Math.round(pieceList[0].srcEndMs)], [0, 30000, 0, 30000]);
});

test('미디어 5초에 2초 해설을 넣으면 원음이 그 자리에서 멈추고, 끝난 뒤 배속 구간이 온다', async () => {
  const chain = buildChain({ mediaDurationMs: 30000 });
  chain.clock.setTimeout(() => chain.narrationScheduler.schedule({ entry: buildEntry({ captionSeq: 1, durationMs: 2000, eventTimeMs: 5000 }), captionCaptureMs: 5000 }), 6000);
  const pieceList = await runToEnd(chain);
  const adIndex = pieceList.findIndex((piece) => piece.kind === 'ad');
  const adPiece = pieceList[adIndex];
  assert.equal(adPiece.adRef, 1);
  assert.equal(Math.round(adPiece.outEndMs - adPiece.outStartMs), 2000);
  const sourceBefore = pieceList.slice(0, adIndex).reverse().find((piece) => piece.kind === 'source');
  assert.equal(Math.round(sourceBefore.srcEndMs), 5000);
  const sourceAfter = pieceList[adIndex + 1];
  assert.equal(sourceAfter.kind, 'source');
  assert.ok((sourceAfter.srcEndMs - sourceAfter.srcStartMs) / (sourceAfter.outEndMs - sourceAfter.outStartMs) > 1.05, '해설 뒤 배속');
  const summary = summarizeTimeline(pieceList);
  assert.equal(Math.round(summary.sourceMediaMs), 30000);
  assert.equal(Math.round(summary.adTotalMs), 2000);
  assert.ok(Math.abs(summary.outputDurationMs - (30000 + summary.adTotalMs + summary.silenceTotalMs - summary.recoveredMs)) < 1);
  assert.ok(summary.recoveredMs > 1900 && summary.recoveredMs < 2300, `해설로 멈춘 만큼만 회수 ${summary.recoveredMs}ms`);
});

test('제품 지연·해설 체인을 끝까지 돌려도 실제 타이머가 남지 않는다', async () => {
  const countRealTimer = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  const beforeCount = countRealTimer();
  const chain = buildChain({ mediaDurationMs: 12000 });
  chain.clock.setTimeout(() => chain.narrationScheduler.schedule({ entry: buildEntry({ captionSeq: 1, durationMs: 1000, eventTimeMs: 1000 }), captionCaptureMs: 1000 }), 2000);
  const pieceList = await runToEnd(chain);
  assert.ok(pieceList.some((piece) => piece.kind === 'ad'));
  assert.equal(countRealTimer(), beforeCount);
});

test('끝난 요소에 play 를 불러도 처음부터 다시 틀지 않는다', async () => {
  const clock = createVirtualClock();
  const element = new FakeMediaElement({ clock, getMaxMediaMs: () => 1000 });
  element.play();
  await clock.runUntil({ isDone: () => element.ended });
  assert.equal(element.currentTime, 1);
  await element.play();
  assert.equal(element.paused, true);
  assert.equal(element.currentTime, 1);
});

test('라이브 끝은 200ms timeslice 로 내리고, 꼬리 모드면 영상 길이를 넘어 가상 시각대로 계속 흐른다', () => {
  let videoTimeMs = 0;
  const source = new FakeDelaySource({ clock: createVirtualClock(), getVideoTimeMs: () => videoTimeMs, mediaDurationMs: 5000, targetDelayMs: 10000 });
  source.start({});
  videoTimeMs = 1399;
  assert.equal(source.getLiveTimeMs(), 1200);
  videoTimeMs = 9000;
  assert.equal(source.getLiveTimeMs(), 5000, '라이브는 영상 길이를 넘지 않는다');
  source.enterTailMode();
  assert.equal(source.getLiveTimeMs(), 9000);
  videoTimeMs = 9399;
  assert.equal(source.getLiveTimeMs(), 9200);
});

test('배속 조각은 하나로 합치고, 배속 사이에 낀 1초 미만 1배속 조각도 합치며, 긴 1배속 조각은 그대로 둔다', () => {
  const compacted = compactPieceList([
    { kind: 'source', outStartMs: 0, outEndMs: 5000, srcStartMs: 0, srcEndMs: 5000 },
    { kind: 'ad', outStartMs: 5000, outEndMs: 7000, adRef: 1 },
    { kind: 'source', outStartMs: 7000, outEndMs: 7250, srcStartMs: 5000, srcEndMs: 5325 },
    { kind: 'source', outStartMs: 7250, outEndMs: 7500, srcStartMs: 5325, srcEndMs: 5637.5 },
    { kind: 'source', outStartMs: 7500, outEndMs: 8250, srcStartMs: 5637.5, srcEndMs: 6387.5 },
    { kind: 'source', outStartMs: 8250, outEndMs: 8500, srcStartMs: 6387.5, srcEndMs: 6662.5 },
    { kind: 'source', outStartMs: 8500, outEndMs: 20000, srcStartMs: 6662.5, srcEndMs: 18162.5 },
  ]);
  assert.deepEqual(compacted.map((piece) => [piece.kind, piece.outStartMs, piece.outEndMs, piece.srcStartMs ?? null, piece.srcEndMs ?? null]), [
    ['source', 0, 5000, 0, 5000], ['ad', 5000, 7000, null, null], ['source', 7000, 8500, 5000, 6662.5], ['source', 8500, 20000, 6662.5, 18162.5],
  ]);
});
