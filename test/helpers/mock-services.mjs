import http from 'node:http';

export const DEFAULT_ASR_SCRIPT_LIST = [
  '오늘은 매출 구조를 설명하겠습니다.',
  '이 그래프를 보시면 매출이 크게 늘었습니다.',
  '다음 자료로 넘어가겠습니다.',
  '여기 이 부분이 이번 분기의 핵심입니다.',
];

export function createToneWav({ durationMs, sampleRate = 16000, frequencyHz = 660 }) {
  const sampleCount = Math.round((sampleRate * durationMs) / 1000);
  const buffer = Buffer.alloc(44 + sampleCount * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + sampleCount * 2, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(sampleCount * 2, 40);
  for (let i = 0; i < sampleCount; i += 1) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate) * 9000), 44 + i * 2);
  }
  return buffer;
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunkList = [];
    request.on('data', (chunk) => chunkList.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunkList)));
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

// 같은 JPEG 는 같은 벡터, 다른 화면은 다른 벡터가 나오게 바이트 분포로 만든다.
function computeMockEmbedding(jpegBuffer) {
  const vector = new Array(32).fill(0);
  for (let i = 0; i < jpegBuffer.length; i += 1) vector[jpegBuffer[i] % 32] += 1;
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

// 제품 판정기(router/*.js)가 parse 하는 모양 그대로의 답. 통합 라우터(판단 LLM)는 트리거 후보마다 공백 O/X 를 낸다(기본 O).
// 무발화는 차단, 지시 판정(judge 모드에서만 씀)은 통과로 둔다.
const CANDIDATE_LINE_PATTERN = /^(\d+)\) \[/;

function buildRouterReply({ input, gapVerdict }) {
  const idList = input.split('\n').map((line) => CANDIDATE_LINE_PATTERN.exec(line)?.[1]).filter(Boolean).map(Number);
  return { judgeList: idList.map((id) => ({ id, gap: gapVerdict, reason: 'mock 판단' })) };
}

const STATIC_JUDGE_REPLY_MAP = {
  silence: { cue: false, reason: 'no_cue' },
  deixis: { caption: true, reason: 'visual_referent' },
};

// 판정 요청은 system 메시지를 앞에 두고 content 를 문자열로 보낸다(judge-llm.js). VLM 요청은 system 없이 content 가 배열이다.
// 판정기 종류는 마지막 user 입력의 틀(prompts/unified-router·silence-judge·deixis-judge 의 build*Input)로 가린다.
function readJudgeInput(parsedBody) {
  const messageList = Array.isArray(parsedBody?.messages) ? parsedBody.messages : [];
  if (messageList[0]?.role !== 'system' || typeof messageList[0].content !== 'string') return null;
  const input = String(messageList.findLast((message) => message.role === 'user')?.content || '');
  if (input.includes('침묵 직전 발화:')) return { kind: 'silence', input };
  if (input.includes('지시 발화:')) return { kind: 'deixis', input };
  if (input.includes('판단(JSON 한 줄):')) return { kind: 'router', input };
  return { kind: 'unknown', input };
}

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function startMockServices({
  asrScriptList = DEFAULT_ASR_SCRIPT_LIST, ttsDurationMs = 800, vlmGroundingText = '빨간 막대 그래프의 상승 구간',
} = {}) {
  const state = {
    asrIndex: 0, asrStatus: 200, ttsStatus: 200, routerGapVerdict: 'O', callCountMap: { vlm: 0, judge: 0, asr: 0, tts: 0, embed: 0 },
  };
  const serverList = [];
  async function listen(handler) {
    const server = http.createServer((request, response) => { handler(request, response).catch(() => sendJson(response, 500, {})); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    serverList.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  }
  // 판정 요청에 답한다. 판정 요청이 아니면 false 를 돌려 VLM 이 답하게 한다.
  function answerJudge(prompt, response) {
    const judge = readJudgeInput(parseJsonOrNull(prompt));
    if (!judge) return false;
    state.callCountMap.judge += 1;
    const reply = judge.kind === 'router' ? buildRouterReply({ input: judge.input, gapVerdict: state.routerGapVerdict }) : STATIC_JUDGE_REPLY_MAP[judge.kind];
    if (!reply) { sendJson(response, 500, { error: `모르는 판정 요청(${judge.kind})` }); return true; }
    sendJson(response, 200, { choices: [{ message: { content: JSON.stringify(reply) } }] });
    return true;
  }
  // 제품 기본값은 판정 LLM 을 VLM 과 따로 띄운 주소(8805)다. mock 도 판정 주소를 따로 연다.
  // SEEON_JUDGE_GPU_URL 을 VLM 주소로 둔 옛 설정도 돌도록 VLM 주소는 판정 요청을 몸통으로 갈라 답한다.
  const judgeOrigin = await listen(async (request, response) => {
    const prompt = (await readBody(request)).toString('utf8');
    if (!answerJudge(prompt, response)) sendJson(response, 400, { error: '판정 요청이 아니다' });
  });
  const vlmOrigin = await listen(async (request, response) => {
    const prompt = (await readBody(request)).toString('utf8');
    if (answerJudge(prompt, response)) return;
    state.callCountMap.vlm += 1;
    let content = vlmGroundingText;
    if (prompt.includes('그대로 옮겨 적어라')) content = '매출 추이\n2분기 | 120억 원';
    else if (prompt.includes('화면 유형을 분류')) {
      content = JSON.stringify({ screenType: 'ppt', pageNumber: null, pageTopic: '매출 추이', description: '분기별 매출 막대 그래프', narration: '분기별 매출 막대 그래프', describedElementList: ['막대 그래프'], isPhotoOnly: false });
    } else if (prompt.includes('라벨을 붙여라')) content = JSON.stringify({ title: '매출 추이', keywordList: ['매출', '분기', '그래프'], summary: '분기별 매출' });
    sendJson(response, 200, { choices: [{ message: { content } }] });
  });
  const asrOrigin = await listen(async (request, response) => {
    await readBody(request);
    state.callCountMap.asr += 1;
    if (state.asrStatus !== 200) { sendJson(response, state.asrStatus, { error: 'mock' }); return; }
    const text = asrScriptList[state.asrIndex % asrScriptList.length];
    state.asrIndex += 1;
    sendJson(response, 200, { text, segmentList: [{ startSec: 0.1, endSec: 2.4, text }], language: 'ko', languageProbability: 0.99 });
  });
  const ttsWav = createToneWav({ durationMs: ttsDurationMs });
  const ttsOrigin = await listen(async (request, response) => {
    await readBody(request);
    state.callCountMap.tts += 1;
    if (state.ttsStatus !== 200) { sendJson(response, state.ttsStatus, { error: 'mock' }); return; }
    response.writeHead(200, { 'content-type': 'audio/wav' });
    response.end(ttsWav);
  });
  const embedOrigin = await listen(async (request, response) => {
    const body = await readBody(request);
    state.callCountMap.embed += 1;
    sendJson(response, 200, { embedding: computeMockEmbedding(body) });
  });
  return {
    urlEnv: {
      SEEON_VLM_URL: `${vlmOrigin}/v1/chat/completions`,
      SEEON_JUDGE_GPU_URL: `${judgeOrigin}/v1/chat/completions`,
      SEEON_ASR_URL: `${asrOrigin}/asr`,
      SEEON_TTS_URL: `${ttsOrigin}/tts`,
      SEEON_TTS_LONG_URL: `${ttsOrigin}/tts-long`,
      SEEON_EMBED_URL: `${embedOrigin}/embed`,
      SEEON_VLM_FALLBACK_ENABLED: 'false',
    },
    state,
    setAsrStatus: (status) => { state.asrStatus = status; },
    setTtsStatus: (status) => { state.ttsStatus = status; },
    setRouterGapVerdict: (verdict) => { state.routerGapVerdict = verdict; },
    close: () => Promise.all(serverList.map((server) => new Promise((resolve) => server.close(resolve)))),
  };
}
