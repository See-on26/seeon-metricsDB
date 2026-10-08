// src/runner/result-identity.mjs
import { MODE_MAP, getModePolicy } from '../product/core-modules.mjs';
import { readSeeonMeetVersion, readFactoryVersion } from '../product/product-version.mjs';
import { buildReportModelConfig } from '../output/ad-report.mjs';

// 결과를 바꾸는 설정만 고른다. 서비스 주소·토큰은 뺀다 — 같은 서버를 터널로 부르든 직접 부르든 결과는 같다.
// ASR·TTS·임베딩 모델은 제품 설정에 없고 GPU 서버가 정하므로 공장이 알 수 없다(서버 모델을 바꾸면 --force 나 새 --out 을 쓴다).
// 값은 결과 JSON 의 config.modelConfig 와 같은 허용 목록 모양(buildReportModelConfig)에서 읽는다. 기록하는 쪽(워커)과
// 견주는 쪽(CLI)이 같은 모양을 거치므로 견주는 값은 늘 기록된 modelConfig 의 값과 같고, 허용 목록 밖 필드·주소의 사용자 정보는
// 견주지 않는다. 그래서 모델 설정을 바꾸지 않은 재실행은 건너뛴다.
export function buildResultConfig({ pipelineConfig, mode = MODE_MAP.delayed }) {
  const modelConfig = buildReportModelConfig({ modelConfig: pipelineConfig });
  return {
    mode,
    delayMs: getModePolicy({ mode }).delayMs,
    vlmModel: modelConfig.vlmModel ?? null,
    isVlmFallbackEnabled: modelConfig.isVlmFallbackEnabled ?? null,
    vlmFallbackModelId: modelConfig.vlmFallbackModelId ?? null,
    judgeBackend: modelConfig.judgeBackend ?? null,
    judgeGpuModel: modelConfig.judgeGpuModel ?? null,
    judgeModelId: modelConfig.judgeModelId ?? null,
    bedrockModelId: modelConfig.bedrockModelId ?? null,
    gapModelId: modelConfig.gapModelByModeMap?.[mode] ?? null,
    routerMode: modelConfig.routerMode ?? null,
    isScaleEnabled: modelConfig.isScaleEnabled ?? null,
  };
}

// 결과를 만든 코드 버전(제품·공장). 워커는 영상을 시작할 때 읽어 실제로 돈 코드를 남긴다.
export function readVersionMap() {
  return { seeonMeet: readSeeonMeetVersion(), factory: readFactoryVersion() };
}

// 결과 JSON 의 repeat: 이 결과가 같은 영상의 몇 번째 회차(index)인지와 그 실행의 반복 수(count). --repeat 1 의 작업은 회차 필드가 없어 { 1, 1 }.
// 재실행 건너뛰기는 index 만 견준다(count 를 늘려도 끝난 회차는 그대로 쓴다). 워커와 시험용 가짜 워커가 같이 쓴다.
export function buildRepeatRecord({ job }) {
  return { index: job.repeatIndex ?? 1, count: job.repeatCount ?? 1 };
}

// 지금 실행이 만들 결과의 정체: 코드 버전과 결과 설정. 끝난 결과를 다시 쓸지 이것과 견준다.
export function readResultIdentity({ pipelineConfig }) {
  return { versionMap: readVersionMap(), resultConfig: buildResultConfig({ pipelineConfig }) };
}

const VERSION_LABEL_MAP = { seeonMeet: 'seeon-meet', factory: '공장' };
const shortCommit = (commit) => (commit ? String(commit).slice(0, 7) : '-');
const formatConfigValue = (value) => (value === undefined ? '없음' : String(value));

function describeVersionMismatch({ label, expected, actual }) {
  if (!actual) return `${label} 버전 기록이 없다(이전 형식)`;
  if (actual.commit !== expected.commit) return `${label} 커밋 ${shortCommit(actual.commit)} → ${shortCommit(expected.commit)}`;
  if (actual.isDirty !== expected.isDirty || (actual.dirtyHash ?? null) !== (expected.dirtyHash ?? null)) {
    return `${label} 작업 트리 수정 내용이 다르다(커밋 ${shortCommit(expected.commit)})`;
  }
  return null;
}

// 끝난 결과(AD 기록 JSON)가 지금과 같은 코드 버전·결과 설정으로 만들어졌는지 견줘, 다른 곳을 사람이 읽을 문장으로 돌려준다(같으면 빈 목록).
// 결과 설정은 양쪽 키를 모두 본다. 설정 항목이 늘거나 줄어도 다른 결과로 친다.
export function listIdentityMismatch({ identity, report }) {
  const mismatchList = [];
  for (const [key, label] of Object.entries(VERSION_LABEL_MAP)) {
    const text = describeVersionMismatch({ label, expected: identity.versionMap[key], actual: report?.[key] });
    if (text) mismatchList.push(text);
  }
  const actualConfig = report?.config?.resultConfig;
  if (!actualConfig) {
    mismatchList.push('결과 설정 기록이 없다(이전 형식)');
    return mismatchList;
  }
  for (const key of new Set([...Object.keys(identity.resultConfig), ...Object.keys(actualConfig)])) {
    if (actualConfig[key] !== identity.resultConfig[key]) {
      mismatchList.push(`결과 설정 ${key} ${formatConfigValue(actualConfig[key])} → ${formatConfigValue(identity.resultConfig[key])}`);
    }
  }
  return mismatchList;
}
