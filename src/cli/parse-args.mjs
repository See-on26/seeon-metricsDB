// src/cli/parse-args.mjs
import { loadPipelineConfig } from '../product/product-loader.mjs';

const DEFAULT_CONCURRENCY = 3;

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
