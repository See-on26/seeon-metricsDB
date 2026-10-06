import { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 시험용 임시 폴더를 만들고, 만든 범위가 끝나면 지운다. 파일 최상위에서 부르면 그 파일의 시험이 모두 끝난 뒤,
// 시험 안에서 부르면(await 뒤여도) 그 시험이 끝난 뒤 지운다. 지우지 않으면 npm test 를 돌릴 때마다 $TMPDIR 에 쌓인다.
// 끝난 자식 프로세스가 막 쓰던 파일이 남아 있어도 지워지게 몇 번 다시 시도한다.
export function makeTempDir(prefix) {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  after(() => fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 3 }));
  return dirPath;
}
