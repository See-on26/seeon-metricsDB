import fs from 'node:fs';
import { compareAdTimeline, formatCompareMarkdown } from '../src/compare/compare-ad-timeline.mjs';

const [factoryJsonPath, labTimelinePath] = process.argv.slice(2);
if (!factoryJsonPath || !labTimelinePath) {
  console.error('사용법: node tools/compare-lab.mjs <공장 _SEEON_AD.json> <실험실 ad-timeline.json>');
  process.exit(2);
}
const result = compareAdTimeline({
  factoryReport: JSON.parse(fs.readFileSync(factoryJsonPath, 'utf8')),
  labTimeline: JSON.parse(fs.readFileSync(labTimelinePath, 'utf8')),
});
process.stdout.write(formatCompareMarkdown(result));
