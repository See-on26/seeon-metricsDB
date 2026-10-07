import {
  installProductLoader, setProductScope, createProductScope, loadRegisterPipeline, loadPipelineConfig, getIpcRegistry, getKiwiTokenizer,
} from './product-loader.mjs';
import { waitKiwiReady } from './kiwi-setup.mjs';
import { createIpcBridge, createRequestContextStorage } from './ipc-bridge.mjs';
import { createScopedFetch } from '../clock/scoped-fetch.mjs';

// 워커 안에서 제품 main 파이프라인을 가상 시계와 함께 세운다. 제품 설정은 process.env 를 읽으므로 env 는 미리 맞춰 둔다.
export function bootProductPipeline({ outDir, clock, log = console }) {
  installProductLoader({ outDir });
  const requestContextStorage = createRequestContextStorage();
  const { readPipelineConfig } = loadPipelineConfig();
  const pipelineConfig = readPipelineConfig(process.env);
  const scopedFetch = createScopedFetch({ clock, pipelineConfig, requestContextStorage });
  setProductScope(createProductScope({ clock, fetch: scopedFetch.fetch }));
  const bridge = createIpcBridge({ registry: getIpcRegistry(), requestContextStorage, log });
  const viewerView = bridge.createViewerView();
  const { registerPipeline } = loadRegisterPipeline();
  const pipelineHandle = registerPipeline({ getViewerView: () => viewerView });
  // 세션을 시작하기 전에 Kiwi 준비를 기다린다. 읽는 동안은 가상 시계를 돌리지 않으므로 영상 시간이 흐르지 않는다.
  const waitTriggerReady = () => waitKiwiReady({ tokenizer: getKiwiTokenizer() });
  return { bridge, scopedFetch, pipelineHandle, pipelineConfig, requestContextStorage, waitTriggerReady };
}
