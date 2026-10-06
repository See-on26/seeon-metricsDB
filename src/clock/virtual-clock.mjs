// 영상 하나를 처리하는 동안 쓰는 가상 시계다. 외부 호출이 진행 중이면 실제 시간과 1:1 로 흘러
// 서비스 지연이 제품과 똑같이 판단에 들어가고, 아무것도 진행 중이 아니면 다음 예정 사건으로 건너뛴다.
const DEFAULT_PERF_ORIGIN_MS = 10000;
const SETTLE_TURN_COUNT = 3;
const MAX_SETTLE_ROUND_COUNT = 100000;
// 제품이 기다리는 파일 쓰기(pipeline.jsonl·컨텍스트 파일)가 끝나기 전에는 건너뛰지 않는다.
const FS_BUSY_RESOURCE_PATTERN = /^(FSReqCallback|FSReqPromise|CloseReq|FileHandleCloseReq)$/;

class VirtualTimer {
  constructor({ seq, dueMs, intervalMs, callback, argList }) {
    this.seq = seq;
    this.dueMs = dueMs;
    this.intervalMs = intervalMs;
    this.callback = callback;
    this.argList = argList;
  }

  // Node 타이머 핸들처럼 부를 수 있게 둔다. 가상 타이머는 프로세스 수명과 무관하다.
  ref() { return this; }

  unref() { return this; }

  hasRef() { return true; }

  [Symbol.toPrimitive]() { return this.seq; }
}

export function createVirtualClock({
  startWallMs = Date.now(), perfOriginMs = DEFAULT_PERF_ORIGIN_MS,
  realNow = () => performance.now(), realSetTimeout = setTimeout, realClearTimeout = clearTimeout,
  realSetImmediate = setImmediate, readActiveResourceList = () => process.getActiveResourcesInfo(),
} = {}) {
  let baseElapsedMs = 0;
  let flowAnchorRealMs = null;
  let inFlightCount = 0;
  let holdCount = 0;
  let nextSeq = 1;
  let wakeUp = null;
  const timerSet = new Set();

  function elapsedMs() {
    return flowAnchorRealMs === null ? baseElapsedMs : baseElapsedMs + (realNow() - flowAnchorRealMs);
  }

  function toDelayMs(ms, minMs) {
    const value = Number(ms);
    return Number.isFinite(value) ? Math.max(minMs, value) : minMs;
  }

  function addTimer({ callback, delayMs, intervalMs, argList }) {
    if (typeof callback !== 'function') throw new TypeError('타이머 콜백은 함수여야 한다');
    const timer = new VirtualTimer({ seq: nextSeq, dueMs: elapsedMs() + delayMs, intervalMs, callback, argList });
    nextSeq += 1;
    timerSet.add(timer);
    return timer;
  }

  function setVirtualTimeout(callback, ms = 0, ...argList) {
    return addTimer({ callback, delayMs: toDelayMs(ms, 0), intervalMs: null, argList });
  }

  // 0ms interval 은 같은 시각에서 끝없이 돌므로 최소 1ms 로 둔다(Node 와 같다).
  function setVirtualInterval(callback, ms = 0, ...argList) {
    const intervalMs = toDelayMs(ms, 1);
    return addTimer({ callback, delayMs: intervalMs, intervalMs, argList });
  }

  function clearVirtualTimer(timer) {
    if (timer instanceof VirtualTimer) timerSet.delete(timer);
  }

  function findEarliestTimer() {
    let earliest = null;
    for (const timer of timerSet) {
      const isEarlier = !earliest || timer.dueMs < earliest.dueMs
        || (timer.dueMs === earliest.dueMs && timer.seq < earliest.seq);
      if (isEarlier) earliest = timer;
    }
    return earliest;
  }

  function fireTimer(timer) {
    if (timer.intervalMs === null) {
      timerSet.delete(timer);
    } else {
      timer.dueMs += timer.intervalMs;
      timer.seq = nextSeq;
      nextSeq += 1;
    }
    timer.callback(...timer.argList);
  }

  function wake() {
    const resolve = wakeUp;
    wakeUp = null;
    resolve?.();
  }

  function waitForWake({ realTimeoutMs = Infinity } = {}) {
    return new Promise((resolve) => {
      let handle = null;
      wakeUp = () => {
        if (handle !== null) realClearTimeout(handle);
        resolve();
      };
      if (Number.isFinite(realTimeoutMs)) {
        handle = realSetTimeout(() => { wakeUp = null; resolve(); }, Math.max(0, realTimeoutMs));
      }
    });
  }

  function beginExternal() {
    if (inFlightCount === 0) flowAnchorRealMs = realNow();
    inFlightCount += 1;
    wake();
  }

  function endExternal() {
    if (inFlightCount === 0) throw new Error('endExternal 이 beginExternal 보다 많이 불렸다');
    inFlightCount -= 1;
    if (inFlightCount === 0) {
      baseElapsedMs = elapsedMs();
      flowAnchorRealMs = null;
    }
    wake();
  }

  async function hold(run) {
    holdCount += 1;
    try {
      return await run();
    } finally {
      holdCount -= 1;
      wake();
    }
  }

  function hasPendingFsWork() {
    return readActiveResourceList().some((name) => FS_BUSY_RESOURCE_PATTERN.test(name));
  }

  const nextTurn = () => new Promise((resolve) => { realSetImmediate(resolve); });

  async function settle() {
    for (let round = 0; round < MAX_SETTLE_ROUND_COUNT; round += 1) {
      for (let turn = 0; turn < SETTLE_TURN_COUNT; turn += 1) await nextTurn();
      if (!hasPendingFsWork()) return;
    }
    throw new Error('가상 시계: 파일 작업이 끝나지 않는다');
  }

  async function runUntil({ isDone, deadlineElapsedMs = Infinity }) {
    for (;;) {
      await settle();
      const earliest = findEarliestTimer();
      if (earliest && earliest.dueMs <= elapsedMs()) {
        fireTimer(earliest);
        continue;
      }
      if (isDone()) return 'done';
      if (elapsedMs() >= deadlineElapsedMs) return 'deadline';
      const nextDueMs = Math.min(earliest ? earliest.dueMs : Infinity, deadlineElapsedMs);
      if (inFlightCount > 0) {
        await waitForWake({ realTimeoutMs: nextDueMs - elapsedMs() });
        continue;
      }
      if (holdCount > 0) {
        await waitForWake();
        continue;
      }
      if (!Number.isFinite(nextDueMs)) {
        throw new Error('가상 시계: 남은 타이머도 진행 중인 작업도 없는데 끝나지 않았다');
      }
      baseElapsedMs = Math.max(baseElapsedMs, nextDueMs);
    }
  }

  return {
    elapsedMs,
    nowWall: () => startWallMs + elapsedMs(),
    nowPerf: () => perfOriginMs + elapsedMs(),
    setTimeout: setVirtualTimeout,
    clearTimeout: clearVirtualTimer,
    setInterval: setVirtualInterval,
    clearInterval: clearVirtualTimer,
    beginExternal,
    endExternal,
    hold,
    settle,
    runUntil,
    get inFlightCount() { return inFlightCount; },
    get holdCount() { return holdCount; },
    get pendingTimerCount() { return timerSet.size; },
  };
}
