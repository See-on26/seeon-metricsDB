import {
  installProductLoader, setProductScope, createProductScope, loadRegisterPipeline, loadPipelineConfig, getIpcRegistry,
} from './product-loader.mjs';
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
  return { bridge, scopedFetch, pipelineHandle, pipelineConfig, requestContextStorage };
}
