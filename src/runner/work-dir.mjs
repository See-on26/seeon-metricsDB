// src/runner/work-dir.mjs
import fs from 'node:fs';
import path from 'node:path';

// 공장이 만든 영상 작업 폴더(<출력>/<출력 이름>/)에 두는 표식. 다시 처리할 때는 이 표식이 있는 폴더만 통째로 지운다.
// --out 을 영상 폴더와 같게 주면 그 자리에 사용자의 같은 이름 폴더(lecture.mp4 옆 lecture/)가 있을 수 있어, 이름만 보고 지우면 안 된다.
// 워커도 표식 없는 폴더에는 쓰지 않는다. 쓰면 그 폴더에 표식이 생겨 다음 재처리 때 사용자 자료째 지워진다.
export const WORK_DIR_MARKER_NAME = '.seeon-factory-work';
const MARKER_TEXT = 'seeon-metricsDB 공장이 만든 작업 폴더다. 이 영상을 다시 처리할 때 폴더째 지운다.\n';

// 심볼릭 링크는 따라가지 않는다. 링크·파일이나 표식 없는 폴더는 공장 것이 아니다.
function readWorkDirState(workDir) {
  let stat;
  try {
    stat = fs.lstatSync(workDir);
  } catch (error) {
    if (error.code === 'ENOENT') return { isMissing: true, isFactoryMade: false, foundText: null };
    throw error;
  }
  if (!stat.isDirectory()) return { isMissing: false, isFactoryMade: false, foundText: stat.isSymbolicLink() ? '심볼릭 링크가' : '파일이' };
  let isMarked = false;
  try {
    isMarked = fs.lstatSync(path.join(workDir, WORK_DIR_MARKER_NAME)).isFile();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { isMissing: false, isFactoryMade: isMarked, foundText: '폴더가' };
}

// 자리가 비었으면 false, 공장 작업 폴더면 true. 공장이 만들지 않은 것이 있으면 아무것도 건드리지 않고 던진다.
function checkFactoryWorkDir({ workDir }) {
  const { isMissing, isFactoryMade, foundText } = readWorkDirState(workDir);
  if (isMissing || isFactoryMade) return isFactoryMade;
  throw new Error(`작업 폴더 자리(${workDir})에 공장 표식(${WORK_DIR_MARKER_NAME})이 없는 ${foundText} 있어 지우지도 쓰지도 않는다`
    + ' — 사용자 자료면 옮기거나 다른 --out 을 쓰고, 표식이 생기기 전 공장이 만든 폴더면 손으로 지운다');
}

// CLI 가 다시 처리하기 전에 부른다. 지울 수 있는지만 먼저 본다(이전 mp3·JSON 을 지우기 전에 멈추려고).
export function assertRemovableWorkDir({ workDir }) {
  checkFactoryWorkDir({ workDir });
}

// 이전 실행의 작업 폴더를 지운다. 없으면 할 일이 없고, 공장 것이 아니면 던진다.
export function removeWorkDir({ workDir }) {
  if (checkFactoryWorkDir({ workDir })) fs.rmSync(workDir, { recursive: true, force: true });
}

// 워커가 작업 폴더를 만들고 바로 표식을 둔다. 이미 공장 폴더면 그대로 쓰고, 공장 것이 아니면 그 안에 쓰지 않고 던진다.
export function prepareWorkDir({ workDir }) {
  if (checkFactoryWorkDir({ workDir })) return;
  fs.mkdirSync(path.dirname(workDir), { recursive: true });
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(workDir, WORK_DIR_MARKER_NAME), MARKER_TEXT);
}
