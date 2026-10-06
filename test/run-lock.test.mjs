import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireRunLock, isPidAlive, RUN_LOCK_FILE_NAME } from '../src/runner/run-lock.mjs';

function makeOutDir(t) {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-lock-'));
  t.after(() => fs.rmSync(dirPath, { recursive: true, force: true }));
  return dirPath;
}

const readLock = (outDir) => JSON.parse(fs.readFileSync(path.join(outDir, RUN_LOCK_FILE_NAME), 'utf8'));
const writeLock = (outDir, owner) => fs.writeFileSync(path.join(outDir, RUN_LOCK_FILE_NAME), JSON.stringify(owner));

test('잠금: pid·호스트·시작 시각을 담아 만들고, 살아 있는 실행이 쥐고 있으면 거절하며, 풀면 다시 잡을 수 있다', (t) => {
  const outDir = makeOutDir(t);
  const lock = acquireRunLock({ outDir, pid: 101, host: 'h1', now: () => new Date('2026-10-06T01:02:03.000Z'), checkPidAlive: () => true });
  assert.deepEqual(readLock(outDir), { pid: 101, host: 'h1', startedAt: '2026-10-06T01:02:03.000Z' });
  assert.throws(
    () => acquireRunLock({ outDir, pid: 202, host: 'h1', checkPidAlive: (pid) => pid === 101 }),
    /이 출력 폴더는 이미 다른 실행\(pid 101 · h1 · 2026-10-06T01:02:03.000Z 시작\)이 쓰고 있다/,
  );
  assert.deepEqual(readLock(outDir).pid, 101, '거절된 쪽은 잠금을 건드리지 않는다');
  lock.release();
  assert.equal(fs.existsSync(path.join(outDir, RUN_LOCK_FILE_NAME)), false);
  const nextLock = acquireRunLock({ outDir, pid: 202, host: 'h1', checkPidAlive: () => true });
  assert.equal(readLock(outDir).pid, 202);
  lock.release();
  assert.equal(readLock(outDir).pid, 202, '남의 잠금은 풀지 않는다');
  nextLock.release();
  assert.deepEqual(fs.readdirSync(outDir), [], '임시 파일이 남지 않는다');
});

test('잠금: 같은 호스트에서 pid 가 죽은 잠금은 낡은 것으로 보고 알린 뒤 가져간다', (t) => {
  const outDir = makeOutDir(t);
  writeLock(outDir, { pid: 303, host: 'h1', startedAt: 's' });
  const takeOverList = [];
  const lock = acquireRunLock({
    outDir, pid: 404, host: 'h1', checkPidAlive: (pid) => pid !== 303, onTakeOver: (holder) => takeOverList.push(holder),
  });
  assert.deepEqual(takeOverList, [{ pid: 303, host: 'h1', startedAt: 's' }]);
  assert.equal(readLock(outDir).pid, 404);
  lock.release();
  assert.deepEqual(fs.readdirSync(outDir), []);
});

test('잠금: 다른 호스트의 잠금·읽지 못하는 잠금은 살았는지 알 수 없어 가져가지 않고 지울 파일을 알려 준다', (t) => {
  const outDir = makeOutDir(t);
  const lockPath = path.join(outDir, RUN_LOCK_FILE_NAME);
  writeLock(outDir, { pid: 505, host: 'other-host', startedAt: 's' });
  assert.throws(
    () => acquireRunLock({ outDir, pid: 606, host: 'h1', checkPidAlive: () => false }),
    (error) => error.message.includes('다른 호스트(other-host)') && error.message.includes(lockPath),
  );
  fs.writeFileSync(lockPath, '{"pid": 5');
  assert.throws(() => acquireRunLock({ outDir, pid: 606, host: 'h1', checkPidAlive: () => false }), /잠금 파일을 읽지 못했다/);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), '{"pid": 5');
});

test('잠금: 실제 프로세스로 살았는지 본다 — 살아 있는 pid 면 거절, 그 프로세스가 끝나면 가져간다', async (t) => {
  const outDir = makeOutDir(t);
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  t.after(() => holder.kill('SIGKILL'));
  writeLock(outDir, { pid: holder.pid, host: os.hostname(), startedAt: 's' });
  assert.equal(isPidAlive(holder.pid), true);
  assert.throws(() => acquireRunLock({ outDir }), /이미 다른 실행/);
  holder.kill('SIGKILL');
  await new Promise((resolve) => { holder.once('exit', resolve); });
  assert.equal(isPidAlive(holder.pid), false);
  const lock = acquireRunLock({ outDir });
  assert.equal(readLock(outDir).pid, process.pid);
  lock.release();
});
