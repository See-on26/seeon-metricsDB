import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleepReal } from 'node:timers/promises';
import { createVirtualClock } from '../src/clock/virtual-clock.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

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
  const filePath = path.join(makeTempDir('clock-'), 'big.bin');
  let isWritten = false;
  const writePromise = fs.promises.writeFile(filePath, Buffer.alloc(32 * 1024 * 1024)).then(() => { isWritten = true; });
  let isWrittenAtFire = null;
  clock.setTimeout(() => { isWrittenAtFire = isWritten; }, 10);
  await clock.runUntil({ isDone: () => isWrittenAtFire !== null });
  // 임시 폴더를 지우기 전에 쓰기가 끝나게 기다린다.
  await writePromise;
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

test('외부 호출 뒤에도 nowWall 은 Date.now 처럼 정수이고 nowPerf 는 소수를 그대로 둔다', () => {
  let fakeRealMs = 1000.25;
  const clock = createVirtualClock({ startWallMs: 1_800_000_000_000, realNow: () => fakeRealMs });
  clock.beginExternal();
  fakeRealMs = 1007.875;
  clock.endExternal();
  assert.equal(clock.nowWall(), 1_800_000_000_007);
  assert.equal(clock.nowPerf(), 10_000 + 7.625);
});

test('외부 호출이 진행 중이면 파일 작업을 기다리지 않고 타이머를 제때 돌린다', async () => {
  const clock = createVirtualClock({ readActiveResourceList: () => ['FSReqCallback'] });
  let firedAtMs = null;
  clock.setTimeout(() => { firedAtMs = clock.elapsedMs(); }, 30);
  clock.beginExternal();
  const realStartedAt = performance.now();
  await clock.runUntil({ isDone: () => firedAtMs !== null });
  clock.endExternal();
  assert.ok(firedAtMs >= 30 && firedAtMs < 150, `타이머 ${firedAtMs}ms`);
  assert.ok(performance.now() - realStartedAt < 1000);
});

test('파일 작업이 시간 상한 안에 끝나지 않으면 남은 작업 종류를 담아 오류를 내고, 그동안 실제 타이머로 양보한다', async () => {
  let fakeRealMs = 0;
  let yieldCount = 0;
  const clock = createVirtualClock({
    realNow: () => { fakeRealMs += 100; return fakeRealMs; },
    realSetTimeout: (callback, ms) => { yieldCount += 1; return setTimeout(callback, ms); },
    readActiveResourceList: () => ['FSReqCallback', 'TTYWrap', 'FSReqCallback'],
  });
  await assert.rejects(clock.settle(), /파일 작업이 10000ms 안에 끝나지 않는다 \(남은 작업: FSReqCallback\)$/);
  assert.ok(yieldCount > 0, '바쁜 대기만 하지 않는다');
});

test('runUntil 을 겹쳐 부르면 바로 오류이고, 끝난 뒤에는 다시 부를 수 있다', async () => {
  const clock = createVirtualClock();
  clock.setTimeout(() => {}, 100);
  let releaseHold = null;
  const holding = clock.hold(() => new Promise((resolve) => { releaseHold = resolve; }));
  const firstRun = clock.runUntil({ isDone: () => clock.pendingTimerCount === 0 });
  await assert.rejects(clock.runUntil({ isDone: () => true }), /runUntil 이 이미 돌고 있다/);
  releaseHold();
  await holding;
  assert.equal(await firstRun, 'done');
  assert.equal(await clock.runUntil({ isDone: () => true }), 'done');
});

test('지연값이 1 이상 2^31-1 이하가 아니면 Node 처럼 1ms 로 두어 순서도 Node 와 같다', async () => {
  const realOrderList = await new Promise((resolve) => {
    const orderList = [];
    setTimeout(() => orderList.push('a'), 1);
    setTimeout(() => orderList.push('b'), 0);
    setTimeout(() => orderList.push('c'), -5);
    setTimeout(() => { orderList.push('d'); resolve(orderList); }, Number.NaN);
  });
  const clock = createVirtualClock();
  const firedList = [];
  const record = (name) => () => firedList.push([name, clock.elapsedMs()]);
  clock.setTimeout(record('a'), 1);
  clock.setTimeout(record('b'), 0);
  clock.setTimeout(record('c'), -5);
  clock.setTimeout(record('d'), Number.NaN);
  clock.setTimeout(record('e'), 2 ** 31);
  clock.setTimeout(record('f'));
  const intervalTimer = clock.setInterval(() => { record('i')(); clock.clearInterval(intervalTimer); }, 0);
  await clock.runUntil({ isDone: () => clock.pendingTimerCount === 0 });
  assert.deepEqual(realOrderList, ['a', 'b', 'c', 'd']);
  assert.deepEqual(firedList, [['a', 1], ['b', 1], ['c', 1], ['d', 1], ['e', 1], ['f', 1], ['i', 1]]);
});

test('타이머 콜백이 await 사슬 끝에서 더 이른 타이머를 걸면, 나중 타이머로 건너뛰기 전에 그것부터 돈다', async () => {
  const clock = createVirtualClock();
  const firedList = [];
  clock.setTimeout(async () => {
    for (let step = 0; step < 100; step += 1) await Promise.resolve();
    clock.setTimeout(() => firedList.push(['early', clock.elapsedMs()]), 50);
  }, 100);
  clock.setTimeout(() => firedList.push(['late', clock.elapsedMs()]), 1000);
  await clock.runUntil({ isDone: () => firedList.length === 2 });
  assert.deepEqual(firedList, [['early', 150], ['late', 1000]]);
});
