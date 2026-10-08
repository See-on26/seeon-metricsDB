import fs from 'node:fs';
import { compareAdTimeline, formatCompareMarkdown } from '../src/compare/compare-ad-timeline.mjs';
import { readDistributionInput, compareAdDistribution, formatDistributionMarkdown } from '../src/compare/compare-ad-distribution.mjs';

// 두 형식: 결과 하나씩 짝짓는 옛 형식(위치 인자 둘)과, 여러 번 돌린 결과를 쪽마다 묶어 분포로 견주는 --factory … --lab … 형식.
const USAGE_TEXT = [
  '사용법: node tools/compare-lab.mjs <공장 _SEEON_AD.json> <실험실 ad-timeline.json>',
  '       node tools/compare-lab.mjs --factory <공장 _SEEON_AD.json>... --lab <실험실 ad-timeline.json>...',
].join('\n');
const DISTRIBUTION_FLAG_LIST = ['--factory', '--lab'];
const ERROR_EXIT_CODE = 2;

// --factory·--lab 뒤의 경로를 다음 인자 이름까지 그 쪽에 모은다. 쪽마다 하나 이상이어야 하고, 다른 인자나 쪽 없는 경로는 받지 않는다(null).
function parseDistributionArgList(argList) {
  const pathListMap = { '--factory': [], '--lab': [] };
  let currentList = null;
  for (const arg of argList) {
    if (DISTRIBUTION_FLAG_LIST.includes(arg)) currentList = pathListMap[arg];
    else if (!currentList || arg.startsWith('--')) return null;
    else currentList.push(arg);
  }
  const { '--factory': factoryPathList, '--lab': labPathList } = pathListMap;
  return factoryPathList.length && labPathList.length ? { factoryPathList, labPathList } : null;
}

// 서로 다른 영상을 섞었거나 파일을 읽지 못하면 이유를 찍고 2 로 끝난다(표는 찍지 않는다). 경고는 stderr 로 낸다.
function runDistributionCompare(argList) {
  const parsed = parseDistributionArgList(argList);
  if (!parsed) {
    console.error(USAGE_TEXT);
    process.exitCode = ERROR_EXIT_CODE;
    return;
  }
  let input;
  try {
    input = readDistributionInput(parsed);
  } catch (error) {
    console.error(`비교하지 못했다: ${error.message}`);
    process.exitCode = ERROR_EXIT_CODE;
    return;
  }
  for (const warning of input.warningList) console.error(`경고: ${warning}`);
  process.stdout.write(formatDistributionMarkdown(compareAdDistribution(input)));
}

const argList = process.argv.slice(2);
if (argList.some((arg) => DISTRIBUTION_FLAG_LIST.includes(arg))) {
  runDistributionCompare(argList);
} else {
  const [factoryJsonPath, labTimelinePath] = argList;
  if (!factoryJsonPath || !labTimelinePath) {
    console.error(USAGE_TEXT);
    process.exit(ERROR_EXIT_CODE);
  }
  const result = compareAdTimeline({
    factoryReport: JSON.parse(fs.readFileSync(factoryJsonPath, 'utf8')),
    labTimeline: JSON.parse(fs.readFileSync(labTimelinePath, 'utf8')),
  });
  process.stdout.write(formatCompareMarkdown(result));
}
