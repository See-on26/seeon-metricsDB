import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepareWorkDir, removeWorkDir, WORK_DIR_MARKER_NAME } from '../src/runner/work-dir.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const FOREIGN_PATTERN = /공장 표식\(\.seeon-factory-work\)이 없는 .*지우지도 쓰지도 않는다/;

function makeUserFolder(workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, 'notes.txt'), '사용자 자료');
}

test('작업 폴더: 워커는 새 폴더를 만들며 표식을 두고, 표식이 있는 폴더는 다시 쓰며, 다시 처리할 때는 표식이 있는 폴더만 통째로 지운다', () => {
  const outDir = path.join(makeTempDir('factory-workdir-'), 'out');
  const workDir = path.join(outDir, 'lecture');
  prepareWorkDir({ workDir });
  assert.ok(fs.lstatSync(path.join(workDir, WORK_DIR_MARKER_NAME)).isFile(), '출력 폴더가 없어도 만들고 표식을 둔다');
  fs.writeFileSync(path.join(workDir, 'pipeline-1.jsonl'), '{}');
  prepareWorkDir({ workDir });
  assert.ok(fs.existsSync(path.join(workDir, 'pipeline-1.jsonl')), '공장이 만든 폴더는 그대로 쓴다');
  removeWorkDir({ workDir });
  assert.equal(fs.existsSync(workDir), false);
  removeWorkDir({ workDir });
  assert.equal(fs.existsSync(outDir), true, '없는 작업 폴더는 지울 것이 없다');
});

test('작업 폴더: 같은 자리에 공장이 만들지 않은 폴더(사용자 폴더)·파일·심볼릭 링크가 있으면 지우지도 그 안에 쓰지도 않고 멈춘다', () => {
  const outDir = makeTempDir('factory-workdir-foreign-');
  const userDir = path.join(outDir, 'lecture');
  makeUserFolder(userDir);
  assert.throws(() => removeWorkDir({ workDir: userDir }), FOREIGN_PATTERN);
  assert.throws(() => prepareWorkDir({ workDir: userDir }), FOREIGN_PATTERN);
  assert.deepEqual(fs.readdirSync(userDir), ['notes.txt'], '사용자 폴더에 표식을 쓰지 않는다');

  const filePath = path.join(outDir, 'memo');
  fs.writeFileSync(filePath, '사용자 파일');
  assert.throws(() => removeWorkDir({ workDir: filePath }), FOREIGN_PATTERN);
  assert.throws(() => prepareWorkDir({ workDir: filePath }), FOREIGN_PATTERN);
  assert.equal(fs.readFileSync(filePath, 'utf8'), '사용자 파일');

  // 링크가 가리키는 곳이 공장 폴더여도 링크 자리는 공장이 만든 것이 아니다.
  const factoryDir = path.join(outDir, 'factory-made');
  prepareWorkDir({ workDir: factoryDir });
  const linkPath = path.join(outDir, 'linked');
  fs.symlinkSync(factoryDir, linkPath);
  assert.throws(() => removeWorkDir({ workDir: linkPath }), FOREIGN_PATTERN);
  assert.ok(fs.existsSync(path.join(factoryDir, WORK_DIR_MARKER_NAME)));
  assert.ok(fs.lstatSync(linkPath).isSymbolicLink());
});
