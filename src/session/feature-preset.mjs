import { createFeatureToggleStore, FEATURE_TOGGLE_STORAGE_KEY } from '../product/core-modules.mjs';

// 평가 설정: 페이지 전환 안내·화자 안내·회의 요약을 끈다. 지시·발화·무발화는 항상 돈다.
export const EVAL_PRESET_MAP = { page_transition: false, speaker_identity: false, meeting_summary: false };

function createMemoryStorage(initialMap) {
  const storageMap = new Map(Object.entries(initialMap));
  return { getItem: (key) => storageMap.get(key) ?? null, setItem: (key, value) => storageMap.set(key, value) };
}

export function buildFeatureToggleStore({ isPageTransitionIncluded = false } = {}) {
  const presetMap = { ...EVAL_PRESET_MAP, page_transition: Boolean(isPageTransitionIncluded) };
  return createFeatureToggleStore({ storage: createMemoryStorage({ [FEATURE_TOGGLE_STORAGE_KEY]: JSON.stringify(presetMap) }) });
}
