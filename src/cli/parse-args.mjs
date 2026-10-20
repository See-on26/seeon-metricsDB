// src/cli/parse-args.mjs
import { loadPipelineConfig } from '../product/product-loader.mjs';

// 동시 처리는 공용 GPU 를 포화시켜 VLM 시간 초과·ASR 지연이 늘고 AD 결과가 동시 1 과 달라진다(README "동시 처리 수").
// 결과를 제품과 같게 두는 1 이 기본이고, 빨리 돌려야 할 때만 --concurrency 로 올린다.
const DEFAULT_CONCURRENCY = 1;

function readPositiveInteger({ value, name }) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${name} 은 1 이상 정수여야 한다: ${value}`);
  return number;
}

function readPositiveNumber({ value, name }) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} 은 0 보다 큰 수여야 한다: ${value}`);
  return number;
}

// --repeat N 은 영상마다 N번 돌린다. 주지 않으면 repeatCount 를 두지 않는다(1번과 같다) — 인자 모양과 실행 기록이 이전과 같게.
export function parseFactoryArgs(argList) {
  const options = { input: null, out: null, concurrency: DEFAULT_CONCURRENCY, language: 'auto', isPageTransitionIncluded: false, isForced: false, limit: null, timeoutMin: null };
  for (let index = 0; index < argList.length; index += 1) {
    const arg = argList[index];
    const readValue = () => {
      const value = argList[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 뒤에 값이 없다`);
      index += 1;
      return value;
    };
    if (arg === '--input') options.input = readValue();
    else if (arg === '--out') options.out = readValue();
    else if (arg === '--concurrency') options.concurrency = readPositiveInteger({ value: readValue(), name: '--concurrency' });
    else if (arg === '--limit') options.limit = readPositiveInteger({ value: readValue(), name: '--limit' });
    else if (arg === '--repeat') options.repeatCount = readPositiveInteger({ value: readValue(), name: '--repeat' });
    else if (arg === '--language') options.language = readValue();
    else if (arg === '--timeout-min') options.timeoutMin = readPositiveNumber({ value: readValue(), name: '--timeout-min' });
    else if (arg === '--include-page-transition') options.isPageTransitionIncluded = true;
    else if (arg === '--force') options.isForced = true;
    else throw new Error(`모르는 인자: ${arg}`);
  }
  if (!options.input) throw new Error('--input <폴더|목록.json> 이 필요하다');
  // 허용 언어는 제품 ASR 설정이 정한다(ko·en·auto).
  const { isAsrLanguage, ASR_LANGUAGE_LIST } = loadPipelineConfig();
  if (!isAsrLanguage(options.language)) throw new Error(`--language 는 ${ASR_LANGUAGE_LIST.join('·')} 중 하나다: ${options.language}`);
  return options;
}
