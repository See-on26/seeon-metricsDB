import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleepReal } from 'node:timers/promises';
import {
  installProductLoader, setProductScope, createProductScope, loadRegisterPipeline, getIpcRegistry, buildScopePrelude,
  PRODUCT_SCOPE_KEY,
} from '../src/product/product-loader.mjs';
import { createVirtualClock } from '../src/clock/virtual-clock.mjs';

// 제품은 프로세스마다 한 번만 로드한다. node --test 는 파일마다 프로세스를 따로 띄운다.
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-loader-'));
const FIXED_WALL_MS = 1_800_000_000_000;
const callCountMap = { nowWall: 0, fetch: 0 };
const fixedScope = {
  nowWall: () => { callCountMap.nowWall += 1; return FIXED_WALL_MS; },
  nowPerf: () => 10_000,
  setTimeout, clearTimeout, setInterval, clearInterval,
  fetch: async () => { callCountMap.fetch += 1; throw new Error('이 테스트는 네트워크를 쓰지 않는다'); },
};
installProductLoader({ outDir });
setProductScope(fixedScope);

test('prelude 는 한 줄이라 제품 오류 행 번호가 원본과 같다', () => {
  assert.equal(buildScopePrelude().includes('\n'), false);
  assert.match(buildScopePrelude(), /globalThis\.__seeonFactoryScope/);
});

test('registerPipeline 이 plain Node 에서 만들어지고 ipcMain 핸들러·리스너를 등록한다', async () => {
  const { registerPipeline } = loadRegisterPipeline();
  const sentList = [];
  const viewerView = { webContents: { send: (channel, payload) => sentList.push([channel, payload.type]) } };
  const handle = registerPipeline({ getViewerView: () => viewerView });
  const { handlerMap, listenerMap } = getIpcRegistry();
  for (const channel of ['pipeline-session-start', 'pipeline-session-end', 'pipeline-audio', 'pipeline-deixis',
    'pipeline-silence', 'pipeline-frame', 'pipeline-slide-text', 'embed-frame', 'pipeline-gap', 'pipeline-feature-toggles']) {
    assert.ok(handlerMap.has(channel), channel);
  }
  for (const channel of ['pipeline-narration-dropped', 'pipeline-debug', 'pipeline-boundary', 'pipeline-slide-mark']) {
    assert.ok(listenerMap.has(channel), channel);
  }
  const result = await handlerMap.get('pipeline-session-start')({}, { mode: 'delayed', asrLanguage: 'en' });
  assert.equal(result.isOk, true);
  assert.equal(result.sessionId, `session-${FIXED_WALL_MS}`, '제품 Date.now 는 범위 시계를 탄다');
  assert.equal(path.dirname(result.recordPath), outDir, 'OUT_DIR 대역');
  assert.equal(handle.getAsrLanguage(), 'en', 'c0ebca0 의 asrLanguage 인자');
  assert.ok(sentList.some(([channel, type]) => channel === 'pipeline-event' && type === 'debug'));
  assert.ok(callCountMap.nowWall > 0);
});

test('범위 Date 는 인자 없이 만들면 범위 시각, 인자가 있으면 그대로다', () => {
  const ScopedDate = globalThis[PRODUCT_SCOPE_KEY].Date;
  assert.equal(new ScopedDate().getTime(), FIXED_WALL_MS);
  assert.equal(new ScopedDate(0).getTime(), 0);
  assert.equal(ScopedDate.now(), FIXED_WALL_MS);
});

test('전역 Date·setTimeout·fetch 는 바꾸지 않는다', () => {
  assert.ok(Math.abs(Date.now() - FIXED_WALL_MS) > 1000);
  assert.equal(globalThis.setTimeout.name, 'setTimeout');
  assert.equal(callCountMap.fetch, 0);
});

test('코어 재사용 목록이 모두 실제로 export 된다', async () => {
  const coreModuleMap = await import('../src/product/core-modules.mjs');
  for (const [name, value] of Object.entries(coreModuleMap)) assert.notEqual(value, undefined, name);
  assert.equal(typeof coreModuleMap.CaptionNarrator, 'function');
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

test('가상 시계가 실제 시간으로 흐른 뒤에도 범위 Date.now 는 정수이고 new Date() 와 같다', async () => {
  const clock = createVirtualClock({ startWallMs: FIXED_WALL_MS });
  setProductScope(createProductScope({ clock, fetch: fixedScope.fetch }));
  try {
    clock.beginExternal();
    await sleepReal(7);
    clock.endExternal();
    const ScopedDate = globalThis[PRODUCT_SCOPE_KEY].Date;
    assert.ok(Number.isInteger(ScopedDate.now()), `Date.now ${ScopedDate.now()}`);
    assert.equal(ScopedDate.now(), new ScopedDate().getTime());
  } finally {
    setProductScope(fixedScope);
  }
});
