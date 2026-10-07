import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startMockServices } from './helpers/mock-services.mjs';
import { resolveProductPath } from '../src/product/product-paths.mjs';

const require = createRequire(import.meta.url);
const { createUnifiedRouter } = require(resolveProductPath('src/main/caption-pipeline/router/unified-router.js'));
const { createSilenceJudge } = require(resolveProductPath('src/main/caption-pipeline/router/silence-judge.js'));
const { createDeixisJudgeClient } = require(resolveProductPath('src/main/caption-pipeline/router/deixis-judge.js'));
const { requestVlmContent } = require(resolveProductPath('src/main/caption-pipeline/agents/shared/vlm-gateway.js'));

const mock = await startMockServices();
after(() => mock.close());
// 제품 기본값처럼 판정 LLM 주소를 VLM 과 따로 두고 Bedrock 키는 비운다(폴백 없이 GPU 답만 쓴다).
const config = {
  vlmUrl: mock.urlEnv.SEEON_VLM_URL, vlmModel: 'qwen', judgeBackend: 'gpu', judgeGpuUrl: mock.urlEnv.SEEON_JUDGE_GPU_URL, judgeGpuModel: 'qwen3.5-9b',
  bedrockApiKey: '', isVlmFallbackEnabled: false,
};
const snapshotCount = () => ({ ...mock.state.callCountMap });
const candidateList = [
  { type: 'demonstrative', phrase: '이 그래프', start: 0, end: 5 }, { type: 'change', phrase: '크게 늘었습니다', start: 15, end: 23 },
];

test('mock 판정 LLM 주소로 온 제품 판정 요청에 판정기마다 맞는 JSON 으로 답한다(라우터는 후보마다 O/X)', async () => {
  const before = snapshotCount();
  const routed = await createUnifiedRouter({ config }).route({ utterance: '이 그래프를 보시면 매출이 크게 늘었습니다.', before: '매출입니다.', after: '', candidateList });
  assert.equal(routed.source, 'gpu');
  assert.deepEqual(routed.judgeList.map((entry) => [entry.id, entry.isGap]), [[1, true], [2, true]]);
  assert.deepEqual(routed.candidateList.map((candidate) => [candidate.type, candidate.subKind, candidate.anchor]),
    [['deixis', 'simple', '이 그래프'], ['interpretation', 'claim_to_value', '크게 늘었습니다']]);
  assert.equal(routed.blockedReason, null);
  assert.deepEqual(await createSilenceJudge({ config }).judge({ transcript: '이 화면을 보시죠', silenceMs: 6000 }),
    { hasCue: false, reason: 'no_cue', source: 'gpu' });
  assert.deepEqual(await createDeixisJudgeClient({ config }).judge({ utterance: '여기 이 부분', before: '', after: '' }),
    { shouldCaption: true, reason: 'visual_referent', source: 'gpu' });
  const after = snapshotCount();
  assert.equal(after.judge - before.judge, 3);
  assert.equal(after.vlm - before.vlm, 0);
});

test('mock 판단 LLM 이 X 로 답하면 라우터는 해설 후보를 내지 않고(no_gap), 후보가 없으면 판정을 부르지 않는다', async (t) => {
  mock.setRouterGapVerdict('X');
  t.after(() => mock.setRouterGapVerdict('O'));
  const before = snapshotCount();
  const routed = await createUnifiedRouter({ config }).route({ utterance: '이 그래프를 보시면', before: '', after: '', candidateList });
  assert.deepEqual([routed.candidateList, routed.blockedReason], [[], 'no_gap']);
  const empty = await createUnifiedRouter({ config }).route({ utterance: '감사합니다.', candidateList: [] });
  assert.deepEqual([empty.source, empty.blockedReason], ['none', 'no_candidate']);
  assert.equal(snapshotCount().judge - before.judge, 1);
});

test('판정 주소를 VLM 주소로 둔 설정도 mock VLM 이 몸통으로 갈라 판정으로 답한다', async () => {
  const before = snapshotCount();
  const sharedConfig = { ...config, judgeGpuUrl: mock.urlEnv.SEEON_VLM_URL };
  const routed = await createUnifiedRouter({ config: sharedConfig }).route({ utterance: '이 그래프를 보시면', candidateList: candidateList.slice(0, 1) });
  assert.deepEqual(routed.candidateList.map((candidate) => candidate.type), ['deixis']);
  const after = snapshotCount();
  assert.deepEqual([after.judge - before.judge, after.vlm - before.vlm], [1, 0]);
});

test('mock VLM 은 이미지가 없는 라벨링 요청도 VLM 으로 답하고 판정으로 세지 않는다', async () => {
  const before = snapshotCount();
  const text = await requestVlmContent({ config, prompt: '이 슬라이드에 라벨을 붙여라', label: '라벨', temperature: 0 });
  assert.deepEqual(JSON.parse(text).keywordList, ['매출', '분기', '그래프']);
  const after = snapshotCount();
  assert.equal(after.vlm - before.vlm, 1);
  assert.equal(after.judge - before.judge, 0);
});
