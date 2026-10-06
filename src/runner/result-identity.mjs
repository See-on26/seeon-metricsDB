// src/runner/result-identity.mjs
import { MODE_MAP, getModePolicy } from '../product/core-modules.mjs';
import { readSeeonMeetVersion, readFactoryVersion } from '../product/product-version.mjs';

// 결과를 바꾸는 설정만 고른다. 서비스 주소·토큰은 뺀다 — 같은 서버를 터널로 부르든 직접 부르든 결과는 같다.
// ASR·TTS·임베딩 모델은 제품 설정에 없고 GPU 서버가 정하므로 공장이 알 수 없다(서버 모델을 바꾸면 --force 나 새 --out 을 쓴다).
export function buildResultConfig({ pipelineConfig, mode = MODE_MAP.delayed }) {
  return {
    mode,
    delayMs: getModePolicy({ mode }).delayMs,
    vlmModel: pipelineConfig.vlmModel ?? null,
    isVlmFallbackEnabled: pipelineConfig.isVlmFallbackEnabled ?? null,
    vlmFallbackModelId: pipelineConfig.vlmFallbackModelId ?? null,
    judgeBackend: pipelineConfig.judgeBackend ?? null,
    judgeGpuModel: pipelineConfig.judgeGpuModel ?? null,
    judgeModelId: pipelineConfig.judgeModelId ?? null,
    bedrockModelId: pipelineConfig.bedrockModelId ?? null,
    gapModelId: pipelineConfig.gapModelByModeMap?.[mode] ?? null,
    routerMode: pipelineConfig.routerMode ?? null,
    isScaleEnabled: pipelineConfig.isScaleEnabled ?? null,
  };
}

// 결과를 만든 코드 버전(제품·공장). 워커는 영상을 시작할 때 읽어 실제로 돈 코드를 남긴다.
export function readVersionMap() {
  return { seeonMeet: readSeeonMeetVersion(), factory: readFactoryVersion() };
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
