import { AsyncLocalStorage } from 'node:async_hooks';

export function createRequestContextStorage() {
  return new AsyncLocalStorage();
}

export function createIpcBridge({ registry, requestContextStorage, log = console }) {
  const rendererListenerMap = new Map();
  let nextSeq = 0;

  function runSafely(label, run) {
    try {
      run();
    } catch (error) {
      log.warn(`[factory] ${label} 처리 실패(무시): ${error.message}`);
    }
  }

  // Electron invoke 처럼 main 은 다음 차례에 받는다. 요청마다 문맥을 열어 그 안의 외부 호출 기록을 모은다.
  async function invokeWithContext(channel, payload) {
    const handler = registry.handlerMap.get(channel);
    if (!handler) throw new Error(`ipcMain 핸들러가 없다: ${channel}`);
    nextSeq += 1;
    const requestContext = { seq: nextSeq, channel, callList: [] };
    const result = await requestContextStorage.run(requestContext, async () => {
      await null;
      return handler({ sender: null }, payload);
    });
    return { result, requestContext };
  }

  async function invoke(channel, payload) {
    return (await invokeWithContext(channel, payload)).result;
  }

  function send(channel, payload) {
    const listenerList = registry.listenerMap.get(channel) || [];
    queueMicrotask(() => {
      for (const listener of listenerList) runSafely(channel, () => listener({ sender: null }, payload));
    });
  }

  // main 의 webContents.send 대역. 보낸 쪽 요청 문맥은 기록용으로 넘기고, 렌더러 쪽 코드는 문맥 밖에서 돈다.
  function deliverToRenderer(channel, payload) {
    const requestContext = requestContextStorage.getStore() || null;
    const listenerList = rendererListenerMap.get(channel) || [];
    queueMicrotask(() => requestContextStorage.exit(() => {
      for (const listener of listenerList) runSafely(channel, () => listener({ payload, requestContext }));
    }));
  }

  function onRendererEvent(channel, listener) {
    if (!rendererListenerMap.has(channel)) rendererListenerMap.set(channel, []);
    rendererListenerMap.get(channel).push(listener);
  }

  return {
    invoke, invokeWithContext, send, onRendererEvent,
    createViewerView: () => ({ webContents: { send: deliverToRenderer, isDestroyed: () => false } }),
  };
}
