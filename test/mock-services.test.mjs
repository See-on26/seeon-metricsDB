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
// 제품 기본값처럼 판정 GPU 주소·모델을 VLM 과 같게 두고 Bedrock 키는 비운다(폴백 없이 GPU 답만 쓴다).
const config = {
  vlmUrl: mock.urlEnv.SEEON_VLM_URL, vlmModel: 'qwen', judgeBackend: 'gpu', judgeGpuUrl: mock.urlEnv.SEEON_VLM_URL, judgeGpuModel: 'qwen',
  bedrockApiKey: '', isVlmFallbackEnabled: false,
};
const snapshotCount = () => ({ ...mock.state.callCountMap });

test('mock VLM 주소로 온 제품 판정 요청에 판정기마다 맞는 JSON 으로 답하고 judge 로 따로 센다', async () => {
  const before = snapshotCount();
  const routed = await createUnifiedRouter({ config }).route({ utterance: '이 그래프를 보시면', before: '매출입니다.', after: '' });
  assert.equal(routed.source, 'gpu');
  assert.deepEqual(routed.candidateList.map((candidate) => [candidate.type, candidate.subKind]), [['deixis', 'simple']]);
  assert.equal(routed.blockedReason, null);
  assert.deepEqual(await createSilenceJudge({ config }).judge({ transcript: '이 화면을 보시죠', silenceMs: 6000 }),
    { hasCue: false, reason: 'no_cue', source: 'gpu' });
  assert.deepEqual(await createDeixisJudgeClient({ config }).judge({ utterance: '여기 이 부분', before: '', after: '' }),
    { shouldCaption: true, reason: 'visual_referent', source: 'gpu' });
  const after = snapshotCount();
  assert.equal(after.judge - before.judge, 3);
  assert.equal(after.vlm - before.vlm, 0);
});

test('mock VLM 은 이미지가 없는 라벨링 요청도 VLM 으로 답하고 판정으로 세지 않는다', async () => {
  const before = snapshotCount();
  const text = await requestVlmContent({ config, prompt: '이 슬라이드에 라벨을 붙여라', label: '라벨', temperature: 0 });
  assert.deepEqual(JSON.parse(text).keywordList, ['매출', '분기', '그래프']);
  const after = snapshotCount();
  assert.equal(after.vlm - before.vlm, 1);
  assert.equal(after.judge - before.judge, 0);
});
