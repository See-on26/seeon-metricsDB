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

export async function startMockServices({
  asrScriptList = DEFAULT_ASR_SCRIPT_LIST, ttsDurationMs = 800, vlmGroundingText = '빨간 막대 그래프의 상승 구간',
} = {}) {
  const state = { asrIndex: 0, asrStatus: 200, callCountMap: { vlm: 0, asr: 0, tts: 0, embed: 0 } };
  const serverList = [];
  async function listen(handler) {
    const server = http.createServer((request, response) => { handler(request, response).catch(() => sendJson(response, 500, {})); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    serverList.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  }
  const vlmOrigin = await listen(async (request, response) => {
    const prompt = (await readBody(request)).toString('utf8');
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
      SEEON_ASR_URL: `${asrOrigin}/asr`,
      SEEON_TTS_URL: `${ttsOrigin}/tts`,
      SEEON_TTS_LONG_URL: `${ttsOrigin}/tts-long`,
      SEEON_EMBED_URL: `${embedOrigin}/embed`,
      SEEON_VLM_FALLBACK_ENABLED: 'false',
    },
    state,
    setAsrStatus: (status) => { state.asrStatus = status; },
    close: () => Promise.all(serverList.map((server) => new Promise((resolve) => server.close(resolve)))),
  };
}
