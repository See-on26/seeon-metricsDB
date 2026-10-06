// src/runner/preflight.mjs
import net from 'node:net';
import { createRequire } from 'node:module';
import { runBinary } from '../media/ffmpeg.mjs';
import { resolveProductPath } from '../product/product-paths.mjs';

const require = createRequire(import.meta.url);
const TUNNEL_POLL_MS = 200;
const TUNNEL_CONFIG_PATH = 'src/main/gpu-tunnel/tunnel-config.js';
const GPU_TUNNEL_PATH = 'src/main/gpu-tunnel/gpu-tunnel.js';
const TUNNEL_STATUS_PATH = 'src/main/gpu-tunnel/tunnel-status.js';
const DEFAULT_PORT_BY_PROTOCOL_MAP = { 'http:': 80, 'https:': 443 };

export function checkTcpPort({ host, port, timeoutMs = 2000 }) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (isOpen) => { socket.destroy(); resolve(isOpen); };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

// 제품 tunnel-config.js 의 FORWARD_URL_KEY_LIST 와 같은 GPU 서비스 주소들(긴 문장 TTS 포함).
const GPU_SERVICE_URL_KEY_LIST = [['VLM', 'vlmUrl'], ['ASR', 'asrUrl'], ['TTS', 'ttsUrl'], ['TTS_LONG', 'ttsLongUrl'], ['EMBED', 'embedUrl']];

// GPU 서비스 주소에서 포트를 열어 보고 닫힌 것만 '<이름> <호스트>:<포트>' 로 돌려준다. 포트를 적지 않은 주소는 프로토콜 기본 포트, 설정에 없는 주소는 건너뛴다.
export async function listClosedPorts({ pipelineConfig, checkPort = checkTcpPort }) {
  const closedPortList = [];
  for (const [label, key] of GPU_SERVICE_URL_KEY_LIST) {
    const url = pipelineConfig[key];
    if (!url) continue;
    const { hostname, port, protocol } = new URL(url);
    const portNumber = Number(port) || DEFAULT_PORT_BY_PROTOCOL_MAP[protocol];
    if (!(await checkPort({ host: hostname, port: portNumber }))) closedPortList.push(`${label} ${hostname}:${portNumber}`);
  }
  return closedPortList;
}

export async function runPreflight({
  pipelineConfig, ffmpegPath, ffprobePath, checkPort = checkTcpPort,
  runVersion = (binaryPath) => runBinary({ binaryPath, argList: ['-version'] }),
}) {
  const problemList = [];
  for (const [label, binaryPath] of [['ffmpeg', ffmpegPath], ['ffprobe', ffprobePath]]) {
    try {
      await runVersion(binaryPath);
    } catch {
      problemList.push(`${label} 를 실행하지 못했다(${binaryPath}) — 설치하거나 SEEON_FACTORY_FFMPEG·SEEON_FACTORY_FFPROBE 로 경로를 준다`);
    }
  }
  const closedPortList = await listClosedPorts({ pipelineConfig, checkPort });
  if (!pipelineConfig.bedrockApiKey) {
    problemList.push('AWS_BEARER_TOKEN_BEDROCK 이 없다 — 라우터·틈 추론이 규칙 폴백으로 떨어져 제품과 다르게 돈다(.env 확인)');
  }
  return { problemList, closedPortList };
}

// 제품 gpu-tunnel.js 는 ssh2 를 연결할 때에야 불러오므로, 로컬 포트를 열기 전에 ssh2 가 제품 쪽에 깔려 있는지 먼저 본다.
function loadProductTunnelFactory() {
  const gpuTunnelPath = resolveProductPath(GPU_TUNNEL_PATH);
  try {
    createRequire(gpuTunnelPath).resolve('ssh2');
    return require(gpuTunnelPath).createGpuTunnel;
  } catch (error) {
    throw new Error(`제품 GPU 터널 모듈을 불러오지 못했다(${error.message.split('\n')[0]}) — npm --prefix seeon-meet ci --omit=dev`);
  }
}

// GPU 포트가 닫혀 있으면 제품의 터널 모듈로 직접 연다(ssh2 는 `npm --prefix seeon-meet ci --omit=dev` 로 설치). 실행 동안 CLI 프로세스가 붙잡는다.
// 제품 index.js 는 electron app 을 읽으므로 쓰지 않고 tunnel-config.js·gpu-tunnel.js 를 바로 쓴다.
export async function startProductTunnel({ env, pipelineConfig, waitMs = 20000, pollMs = TUNNEL_POLL_MS, createTunnel = null }) {
  const { readTunnelConfig, buildForwardList, TUNNEL_MODE_MAP } = require(resolveProductPath(TUNNEL_CONFIG_PATH));
  const { TUNNEL_STATUS_MAP, describeTunnelStatus } = require(resolveProductPath(TUNNEL_STATUS_PATH));
  // 다른 터널이 이미 포트를 쥐고 있으면(external) 그 터널로 닿는다.
  const readyStatusList = [TUNNEL_STATUS_MAP.connected, TUNNEL_STATUS_MAP.external];
  const tunnelConfig = readTunnelConfig({ env });
  if (tunnelConfig.mode === TUNNEL_MODE_MAP.off || !tunnelConfig.keyPath) return null;
  const tunnel = (createTunnel || loadProductTunnelFactory())({ tunnelConfig, forwardList: buildForwardList({ pipelineConfig }) });
  try {
    await tunnel.start();
    for (let waitedMs = 0; waitedMs < waitMs; waitedMs += pollMs) {
      if (readyStatusList.includes(tunnel.getStatus().status)) return tunnel;
      await new Promise((resolve) => { setTimeout(resolve, pollMs); });
    }
    throw new Error(`GPU 터널이 제때 연결되지 않았다 — 마지막 상태: ${describeTunnelStatus(tunnel.getStatus())}`);
  } catch (error) {
    await tunnel.stop();
    throw error;
  }
}
