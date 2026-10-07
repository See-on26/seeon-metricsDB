// 영상 하나를 처리하는 동안 쓰는 가상 시계다. 외부 호출이 진행 중이면 실제 시간과 1:1 로 흘러
// 서비스 지연이 제품과 똑같이 판단에 들어가고, 아무것도 진행 중이 아니면 다음 예정 사건으로 건너뛴다.
const DEFAULT_PERF_ORIGIN_MS = 10000;
const SETTLE_TURN_COUNT = 3;
// 파일 작업 대기는 실제 시간으로 상한을 둔다. 처음 몇 라운드는 setImmediate 로 빨리 확인하고,
// 그 뒤로는 실제 타이머로 1ms 씩 양보해 바쁜 대기로 CPU 를 쓰지 않는다.
const SETTLE_TIMEOUT_MS = 10000;
const SETTLE_SPIN_ROUND_COUNT = 20;
const SETTLE_YIELD_MS = 1;
// Node 타이머와 같은 지연 범위다. 벗어나면(0·음수·NaN·너무 큼) Node 처럼 1ms 로 둔다.
const MIN_DELAY_MS = 1;
const MAX_DELAY_MS = 2 ** 31 - 1;
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
  let isRunning = false;
  const timerSet = new Set();

  function elapsedMs() {
    return flowAnchorRealMs === null ? baseElapsedMs : baseElapsedMs + (realNow() - flowAnchorRealMs);
  }

  function toDelayMs(ms) {
    const value = Number(ms);
    return value >= MIN_DELAY_MS && value <= MAX_DELAY_MS ? value : MIN_DELAY_MS;
  }

  function addTimer({ callback, delayMs, intervalMs, argList }) {
    if (typeof callback !== 'function') throw new TypeError('타이머 콜백은 함수여야 한다');
    const timer = new VirtualTimer({ seq: nextSeq, dueMs: elapsedMs() + delayMs, intervalMs, callback, argList });
    nextSeq += 1;
    timerSet.add(timer);
    return timer;
  }

  function setVirtualTimeout(callback, ms, ...argList) {
    return addTimer({ callback, delayMs: toDelayMs(ms), intervalMs: null, argList });
  }

  function setVirtualInterval(callback, ms, ...argList) {
    const intervalMs = toDelayMs(ms);
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

  function readFsBusyList() {
    return readActiveResourceList().filter((name) => FS_BUSY_RESOURCE_PATTERN.test(name));
  }

  const nextTurn = () => new Promise((resolve) => { realSetImmediate(resolve); });

  const yieldReal = (ms) => new Promise((resolve) => { realSetTimeout(resolve, ms); });

  async function drainTurns() {
    for (let turn = 0; turn < SETTLE_TURN_COUNT; turn += 1) await nextTurn();
  }

  async function waitForFsIdle({ shouldStop = () => false } = {}) {
    const startedAtRealMs = realNow();
    for (let round = 0; ; round += 1) {
      await drainTurns();
      const fsBusyList = readFsBusyList();
      if (fsBusyList.length === 0 || shouldStop()) return;
      if (realNow() - startedAtRealMs >= SETTLE_TIMEOUT_MS) {
        const kindText = [...new Set(fsBusyList)].join(', ');
        throw new Error(`가상 시계: 파일 작업이 ${SETTLE_TIMEOUT_MS}ms 안에 끝나지 않는다 (남은 작업: ${kindText})`);
      }
      if (round >= SETTLE_SPIN_ROUND_COUNT) await yieldReal(SETTLE_YIELD_MS);
    }
  }

  // 마이크로태스크·setImmediate 몇 턴을 돌리고, 진행 중인 파일 작업이 끝날 때까지 기다린다.
  function settle() {
    return waitForFsIdle();
  }

  // 시간이 흐르는 동안(외부 호출 중)에는 파일 작업을 기다리지 않아 만기 타이머가 늦지 않는다.
  // 파일 작업은 유휴 구간을 건너뛰기 직전에만 기다리고, 그 사이 유휴가 끝나면 기다림을 멈춘다.
  async function driveUntil({ isDone, deadlineElapsedMs }) {
    for (;;) {
      await drainTurns();
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
      if (readFsBusyList().length > 0) {
        await waitForFsIdle({ shouldStop: () => inFlightCount > 0 || holdCount > 0 });
        continue;
      }
      if (!Number.isFinite(nextDueMs)) {
        throw new Error('가상 시계: 남은 타이머도 진행 중인 작업도 없는데 끝나지 않았다');
      }
      baseElapsedMs = Math.max(baseElapsedMs, nextDueMs);
    }
  }

  // 대기 자리(wakeUp)가 하나뿐이라 겹쳐 돌면 앞선 호출이 깨어나지 못한다. 겹치면 바로 오류를 낸다.
  async function runUntil({ isDone, deadlineElapsedMs = Infinity }) {
    if (isRunning) throw new Error('가상 시계: runUntil 이 이미 돌고 있다');
    isRunning = true;
    try {
      return await driveUntil({ isDone, deadlineElapsedMs });
    } finally {
      isRunning = false;
    }
  }

  return {
    elapsedMs,
    // 제품 Date.now 자리라 실제 Date.now 처럼 정수로 둔다. 외부 호출 중에는 performance.now 의 소수부가 경과에 섞인다.
    nowWall: () => Math.floor(startWallMs + elapsedMs()),
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
