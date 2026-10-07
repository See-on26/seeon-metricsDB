import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  checkKiwiSetup, waitKiwiReady, buildTestSetupMessage, KIWI_PACKAGE_HINT, KIWI_MODEL_HINT,
} from '../src/product/kiwi-setup.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const TEST_SETUP_TOOL_PATH = fileURLToPath(new URL('../tools/check-test-setup.mjs', import.meta.url));

const KIWI_MODEL_FILE_LIST = ['sj.morph', 'cong.mdl', 'combiningRule.txt', 'extract.mdl', 'default.dict'];

test('Kiwi 점검: 제품이 개발 실행에서 읽는 seeon-meet/vendor/kiwi-model 과 kiwi-nlp 가 있으면 문제가 없다(npm test 의 준비물)', async () => {
  assert.deepEqual(await checkKiwiSetup(), []);
});

test('Kiwi 점검: 모델 폴더가 비었거나 VERSION 이 다르면 그 폴더와 setup:kiwi 안내를 낸다', async () => {
  const emptyDir = makeTempDir('factory-kiwi-empty-');
  const [emptyProblem] = await checkKiwiSetup({ modelDir: emptyDir });
  assert.equal(emptyProblem, `한국어 트리거 형태소 분석 모델(Kiwi 0.24.0)이 없다(${emptyDir}) — ${KIWI_MODEL_HINT}`);
  const staleDir = makeTempDir('factory-kiwi-stale-');
  for (const name of KIWI_MODEL_FILE_LIST) fs.writeFileSync(path.join(staleDir, name), 'x');
  fs.writeFileSync(path.join(staleDir, 'VERSION'), '0.23.0\n');
  assert.deepEqual(await checkKiwiSetup({ modelDir: staleDir }), [`한국어 트리거 형태소 분석 모델(Kiwi 0.24.0)이 없다(${staleDir}) — ${KIWI_MODEL_HINT}`]);
});

test('Kiwi 점검: kiwi-nlp(wasm)를 찾지 못하면 npm ci 안내를 낸다', async () => {
  const problemList = await checkKiwiSetup({ resolveKiwiWasm: () => { throw new Error("Cannot find module 'kiwi-nlp/dist/kiwi-wasm.wasm'"); } });
  assert.deepEqual(problemList, [`한국어 트리거 형태소 분석기 의존성 kiwi-nlp 를 seeon-meet 에서 찾지 못했다 — ${KIWI_PACKAGE_HINT}`]);
});

test('Kiwi 준비: 형태소 분석기를 못 띄우면 원인과 설치 명령 둘을 담아 실패하고, 만들어지지 않았으면 그것을 알린다', async () => {
  const failingTokenizer = { load: async () => { throw new Error('ENOENT: vendor/kiwi-model/sj.morph'); } };
  await assert.rejects(waitKiwiReady({ tokenizer: failingTokenizer }),
    new Error(`한국어 트리거 형태소 분석기(Kiwi)를 띄우지 못했다(ENOENT: vendor/kiwi-model/sj.morph) — ${KIWI_PACKAGE_HINT} · ${KIWI_MODEL_HINT}`));
  await assert.rejects(waitKiwiReady({ tokenizer: null }), /제품 파이프라인이 Kiwi 형태소 분석기를 만들지 않았다/);
  await waitKiwiReady({ tokenizer: { load: async () => ({ elapsedMs: 0 }) } });
});

test('npm test 준비 점검 문구: 문제마다 한 줄과 준비 명령 둘을 한 번에 보여 준다', () => {
  const message = buildTestSetupMessage([`한국어 트리거 형태소 분석 모델(Kiwi 0.24.0)이 없다(/x/vendor/kiwi-model) — ${KIWI_MODEL_HINT}`]);
  assert.equal(message, [
    '[pretest] npm test 준비물이 없다 — 제품 파이프라인을 세우는 시험이 Kiwi 를 띄우므로 건너뛰지 않고 멈춘다',
    `  - 한국어 트리거 형태소 분석 모델(Kiwi 0.24.0)이 없다(/x/vendor/kiwi-model) — ${KIWI_MODEL_HINT}`,
    `  준비: ${KIWI_PACKAGE_HINT} && ${KIWI_MODEL_HINT}`,
  ].join('\n'));
});

test('pretest 도구는 준비물이 있으면 아무것도 찍지 않고 0 으로 끝난다', () => {
  const run = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', TEST_SETUP_TOOL_PATH], { encoding: 'utf8' });
  assert.deepEqual([run.status, run.stdout, run.stderr], [0, '', '']);
});
