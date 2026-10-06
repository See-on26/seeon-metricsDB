// src/product/product-version.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FACTORY_ROOT, SEEON_MEET_ROOT } from './product-paths.mjs';

// 공장 코드 중 결과에 영향을 주는 곳. 문서·테스트·도구만 고친 작업 트리는 수정으로 보지 않는다.
const FACTORY_CODE_PATHSPEC_LIST = ['src', 'package.json'];
const DIRTY_HASH_LENGTH = 16;

function runGit({ repoDir, argList }) {
  return execFileSync('git', ['-C', repoDir, ...argList], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }).toString();
}

// 수정 내용의 지문. 추적 파일은 HEAD 와의 차이 전체, 새 파일은 경로·크기·수정 시각으로 잰다(큰 파일을 다 읽지 않는다).
function computeDirtyHash({ repoDir, pathspecList }) {
  const hash = crypto.createHash('sha256');
  hash.update(runGit({ repoDir, argList: ['diff', 'HEAD', '--binary', '--', ...pathspecList] }));
  const untrackedList = runGit({ repoDir, argList: ['ls-files', '--others', '--exclude-standard', '-z', '--', ...pathspecList] })
    .split('\0').filter(Boolean).sort();
  for (const relativePath of untrackedList) {
    const stat = fs.statSync(path.join(repoDir, relativePath));
    hash.update(`\0${relativePath}\0${stat.size}\0${stat.mtimeMs}`);
  }
  return hash.digest('hex').slice(0, DIRTY_HASH_LENGTH);
}

// 결과가 어느 커밋으로 만들어졌는지 남긴다. 작업 트리가 수정됐으면 수정 내용의 지문(dirtyHash)을 붙여 같은 커밋에서 수정만 다른 결과를 가른다.
// pathspecList 를 주면 그 경로만 본다. git 이 없거나 실패하면 모두 null.
export function readGitVersion({ repoDir, pathspecList = [] }) {
  try {
    const commit = runGit({ repoDir, argList: ['rev-parse', 'HEAD'] }).trim();
    const isDirty = runGit({ repoDir, argList: ['status', '--porcelain', '--untracked-files=all', '--', ...pathspecList] }).trim().length > 0;
    return { commit, isDirty, dirtyHash: isDirty ? computeDirtyHash({ repoDir, pathspecList }) : null };
  } catch {
    return { commit: null, isDirty: null, dirtyHash: null };
  }
}

// 서브모듈 seeon-meet(제품) 버전.
export function readSeeonMeetVersion() {
  return readGitVersion({ repoDir: SEEON_MEET_ROOT });
}

// 공장 자신의 버전. 세션 시뮬레이터·연결 코드가 바뀌면 같은 제품 커밋이라도 결과가 달라진다.
export function readFactoryVersion() {
  return readGitVersion({ repoDir: FACTORY_ROOT, pathspecList: FACTORY_CODE_PATHSPEC_LIST });
}
