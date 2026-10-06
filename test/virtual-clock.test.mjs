import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleepReal } from 'node:timers/promises';
import { createVirtualClock } from '../src/clock/virtual-clock.mjs';
import { createProductScope } from '../src/product/product-loader.mjs';

test('진행 중인 외부 호출이 없으면 다음 타이머로 바로 건너뛴다', async () => {
  const clock = createVirtualClock({ startWallMs: 1_000_000 });
  const firedList = [];
  clock.setTimeout(() => firedList.push(['b', clock.elapsedMs()]), 5000);
  clock.setTimeout(() => firedList.push(['a', clock.elapsedMs()]), 1000);
  const realStartedAt = performance.now();
  await clock.runUntil({ isDone: () => firedList.length === 2 });
  assert.deepEqual(firedList, [['a', 1000], ['b', 5000]]);
  assert.equal(clock.nowWall(), 1_005_000);
  assert.equal(clock.nowPerf(), 10_000 + 5000);
  assert.ok(performance.now() - realStartedAt < 500);
});

test('같은 시각 타이머는 등록 순서로 돌고, interval 은 같은 간격으로 반복하며 지울 수 있다', async () => {
  const clock = createVirtualClock();
  const firedList = [];
  const intervalTimer = clock.setInterval(() => firedList.push(`i${clock.elapsedMs()}`), 250);
  clock.setTimeout(() => firedList.push('t250'), 250);
  clock.setTimeout(() => clock.clearInterval(intervalTimer), 760);
  await clock.runUntil({ isDone: () => clock.pendingTimerCount === 0 });
  assert.deepEqual(firedList, ['i250', 't250', 'i500', 'i750']);
});

test('외부 호출이 진행 중이면 실제 시간과 1:1 로 흐르고 그 사이 타이머도 제때 돈다', async () => {
  const clock = createVirtualClock();
  const firedAtList = [];
  clock.setTimeout(() => firedAtList.push(clock.elapsedMs()), 50);
  clock.beginExternal();
  sleepReal(150).then(() => clock.endExternal());
  await clock.runUntil({ isDone: () => clock.inFlightCount === 0 });
  assert.equal(firedAtList.length, 1);
  assert.ok(firedAtList[0] >= 50 && firedAtList[0] < 130, `타이머 ${firedAtList[0]}ms`);
  assert.ok(clock.elapsedMs() >= 140 && clock.elapsedMs() < 400, `경과 ${clock.elapsedMs()}ms`);
});

test('hold 중에는 시간이 멈추고, 끝난 뒤에야 다음 타이머로 건너뛴다', async () => {
  const clock = createVirtualClock();
  let isHoldDone = false;
  let seen = null;
  clock.setTimeout(() => { seen = { elapsedMs: clock.elapsedMs(), isHoldDone }; }, 1000);
  const holding = clock.hold(async () => {
    const before = clock.elapsedMs();
    await sleepReal(80);
    assert.equal(clock.elapsedMs(), before, 'hold 중 시간 정지');
    isHoldDone = true;
  });
  await clock.runUntil({ isDone: () => seen !== null });
  await holding;
  assert.deepEqual(seen, { elapsedMs: 1000, isHoldDone: true });
});

test('끝나지 않은 파일 쓰기가 있으면 건너뛰지 않는다', async () => {
  const clock = createVirtualClock();
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clock-')), 'big.bin');
  let isWritten = false;
  fs.promises.writeFile(filePath, Buffer.alloc(32 * 1024 * 1024)).then(() => { isWritten = true; });
  let isWrittenAtFire = null;
  clock.setTimeout(() => { isWrittenAtFire = isWritten; }, 10);
  await clock.runUntil({ isDone: () => isWrittenAtFire !== null });
  assert.equal(isWrittenAtFire, true);
});

test('할 일도 타이머도 없는데 끝나지 않으면 멈추지 않고 오류를 낸다', async () => {
  const clock = createVirtualClock();
  await assert.rejects(clock.runUntil({ isDone: () => false }), /남은 타이머도 진행 중인 작업도 없는데/);
});

test('deadline 에 닿으면 그 시각에서 멈추고 deadline 을 돌려준다', async () => {
  const clock = createVirtualClock();
  clock.setInterval(() => {}, 200);
  assert.equal(await clock.runUntil({ isDone: () => false, deadlineElapsedMs: 1000 }), 'deadline');
  assert.equal(clock.elapsedMs(), 1000);
});

test('endExternal 을 더 많이 부르면 오류다', () => {
  const clock = createVirtualClock();
  assert.throws(() => clock.endExternal(), /beginExternal 보다 많이/);
});

test('제품 범위로 넘긴 메서드는 this 없이 불려도 같은 시계를 쓴다', async () => {
  const clock = createVirtualClock({ startWallMs: 2_000_000 });
  const scope = createProductScope({ clock, fetch: null });
  const { setTimeout: setTimer, clearTimeout: clearTimer, setInterval: setRepeat, clearInterval: clearRepeat } = scope;
  const owner = { setTimer, firedList: [] };
  owner.setTimer(() => owner.firedList.push(scope.nowWall()), 300);
  clearTimer(setTimer(() => owner.firedList.push('cleared'), 100));
  const repeatTimer = setRepeat(() => { owner.firedList.push('repeat'); clearRepeat(repeatTimer); }, 200);
  await clock.runUntil({ isDone: () => clock.pendingTimerCount === 0 });
  assert.deepEqual(owner.firedList, ['repeat', 2_000_300]);
  assert.equal(scope.nowPerf(), 10_000 + 300);
});
