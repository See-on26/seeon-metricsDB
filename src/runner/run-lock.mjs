// src/runner/run-lock.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 출력 폴더 하나에 실행 하나만 붙게 하는 잠금 파일. 점으로 시작하는 영상 출력 이름은 쓰지 않으므로(video-list) 겹치지 않는다.
export const RUN_LOCK_FILE_NAME = '.factory.lock';
const ACQUIRE_ATTEMPT_LIMIT = 3;

// 그 pid 의 프로세스가 있는지 본다. 권한이 없다(EPERM)는 것은 다른 사용자의 프로세스가 있다는 뜻이다.
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readLockOwner(lockPath) {
  try {
    const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return Number.isInteger(owner?.pid) ? owner : null;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    return null;
  }
}

const isSameOwner = (left, right) => Boolean(left && right) && left.pid === right.pid && left.host === right.host && left.startedAt === right.startedAt;
const describeOwner = (owner) => `pid ${owner.pid} · ${owner.host} · ${owner.startedAt} 시작`;

// 낡은 잠금을 치운다. 확인과 지우기 사이에 다른 실행이 새로 잡았을 수 있으므로, 먼저 이름을 바꿔 그 자리를 통째로 가져온 뒤
// 가져온 것이 확인한 낡은 잠금일 때만 지운다. 다른 실행의 새 잠금이었으면 제자리에 되돌려 놓는다.
function removeStaleLock({ lockPath, staleOwner, pid }) {
  const movedPath = `${lockPath}.stale-${pid}`;
  try {
    fs.renameSync(lockPath, movedPath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  try {
    if (!isSameOwner(readLockOwner(movedPath), staleOwner)) fs.linkSync(movedPath, lockPath);
  } finally {
    fs.rmSync(movedPath, { force: true });
  }
}

// 이 실행이 잡은 잠금일 때만 지운다. 신호·예외 등 어떤 끝에서도 부를 수 있게 동기로 돈다.
function releaseRunLock({ lockPath, owner }) {
  if (isSameOwner(readLockOwner(lockPath), owner)) fs.rmSync(lockPath, { force: true });
}

// 같은 출력 폴더에 두 실행이 붙으면 같은 작업 파일·mp3·JSON 을 덮어써 섞인 결과가 완료로 남을 수 있다. 실행 하나만 붙게 잠근다.
// 내용을 다 쓴 임시 파일을 link 로 걸어, 잠금 파일은 늘 완전한 내용으로만 생기고 이미 있으면 실패한다(EEXIST).
// 잠금이 있으면: 그 pid 가 살아 있으면 거절, 같은 호스트에서 pid 가 죽었으면 낡은 잠금으로 보고 onTakeOver 로 알린 뒤 가져간다.
// 다른 호스트의 잠금·읽지 못하는 잠금은 살았는지 알 수 없어 가져가지 않는다. 돌려준 release 로 푼다.
export function acquireRunLock({
  outDir, pid = process.pid, host = os.hostname(), now = () => new Date(), checkPidAlive = isPidAlive, onTakeOver = () => {},
}) {
  const lockPath = path.join(outDir, RUN_LOCK_FILE_NAME);
  const owner = { pid, host, startedAt: now().toISOString() };
  const tempPath = `${lockPath}.${pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(owner));
  try {
    for (let attempt = 0; attempt < ACQUIRE_ATTEMPT_LIMIT; attempt += 1) {
      try {
        fs.linkSync(tempPath, lockPath);
        return { lockPath, owner, release: () => releaseRunLock({ lockPath, owner }) };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const holder = readLockOwner(lockPath);
      if (holder === undefined) continue;
      if (holder === null) {
        throw new Error(`잠금 파일을 읽지 못했다(${lockPath}) — 이 출력 폴더를 쓰는 다른 실행이 없으면 지우고 다시 돌린다`);
      }
      if (holder.host !== host) {
        throw new Error(`다른 호스트(${holder.host})의 실행(${describeOwner(holder)})이 이 출력 폴더를 잠갔다 — 그 실행이 끝났으면 ${lockPath} 를 지운다`);
      }
      if (checkPidAlive(holder.pid)) {
        throw new Error(`이 출력 폴더는 이미 다른 실행(${describeOwner(holder)})이 쓰고 있다 — 그 실행이 끝난 뒤 다시 돌리거나 다른 --out 을 쓴다(그 pid 가 공장이 아니면 ${lockPath} 를 지운다)`);
      }
      onTakeOver(holder);
      removeStaleLock({ lockPath, staleOwner: holder, pid });
    }
    throw new Error(`잠금을 잡지 못했다(${lockPath}) — 다른 실행과 동시에 잡으려 했다. 잠시 뒤 다시 돌린다`);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}
