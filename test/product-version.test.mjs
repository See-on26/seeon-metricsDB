import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readSeeonMeetVersion, readFactoryVersion, readGitVersion } from '../src/product/product-version.mjs';
import { SEEON_MEET_ROOT, FACTORY_ROOT } from '../src/product/product-paths.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

test('제품 버전: 서브모듈 seeon-meet 의 HEAD 커밋과 수정 여부를 읽는다', () => {
  const { commit, isDirty } = readSeeonMeetVersion();
  assert.equal(commit, execFileSync('git', ['-C', SEEON_MEET_ROOT, 'rev-parse', 'HEAD']).toString().trim());
  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.equal(typeof isDirty, 'boolean');
});

test('공장 버전: 저장소 HEAD 커밋과, 결과에 영향을 주는 코드(src·package.json)만 본 수정 여부·수정 내용 해시를 읽는다', () => {
  const repoDir = makeTempDir('factory-version-');
  const git = (...argList) => execFileSync('git', ['-C', repoDir, ...argList], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim();
  git('init', '-q');
  fs.mkdirSync(path.join(repoDir, 'src'));
  fs.writeFileSync(path.join(repoDir, 'src', 'a.mjs'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# r\n');
  git('add', 'src/a.mjs', 'README.md');
  git('commit', '-q', '-m', 'init');
  const read = () => readGitVersion({ repoDir, pathspecList: ['src', 'package.json'] });
  assert.deepEqual(read(), { commit: git('rev-parse', 'HEAD'), isDirty: false, dirtyHash: null });
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# 문서만 고침\n');
  fs.writeFileSync(path.join(repoDir, 'notes.txt'), '메모');
  assert.equal(read().isDirty, false, '결과에 영향 없는 파일 수정은 보지 않는다');
  fs.writeFileSync(path.join(repoDir, 'src', 'a.mjs'), 'export const a = 2;\n');
  const firstEdit = read();
  assert.equal(firstEdit.isDirty, true);
  assert.match(firstEdit.dirtyHash, /^[0-9a-f]{16}$/);
  assert.deepEqual(read(), firstEdit, '같은 수정이면 같은 해시');
  fs.writeFileSync(path.join(repoDir, 'src', 'a.mjs'), 'export const a = 3;\n');
  assert.notEqual(read().dirtyHash, firstEdit.dirtyHash, '수정 내용이 바뀌면 해시가 바뀐다');
  fs.writeFileSync(path.join(repoDir, 'src', 'b.mjs'), 'export const b = 1;\n');
  const withNewFile = read();
  assert.notEqual(withNewFile.dirtyHash, firstEdit.dirtyHash, '새 파일도 수정으로 본다');
  assert.deepEqual(readGitVersion({ repoDir: path.join(repoDir, '없는-폴더') }), { commit: null, isDirty: null, dirtyHash: null });
});

test('공장 버전: 이 저장소의 커밋을 읽는다', () => {
  const { commit, isDirty } = readFactoryVersion();
  assert.equal(commit, execFileSync('git', ['-C', FACTORY_ROOT, 'rev-parse', 'HEAD']).toString().trim());
  assert.equal(typeof isDirty, 'boolean');
});
