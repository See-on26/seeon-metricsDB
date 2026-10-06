// src/product/electron-shim.cjs
// 제품 main 파이프라인이 require('electron') 으로 받는 ipcMain 대역이다. 등록된 핸들러·리스너를 표로 들고 있다.
const handlerMap = new Map();
const listenerMap = new Map();

const ipcMain = {
  handle(channel, handler) { handlerMap.set(channel, handler); },
  removeHandler(channel) { handlerMap.delete(channel); },
  on(channel, listener) {
    if (!listenerMap.has(channel)) listenerMap.set(channel, []);
    listenerMap.get(channel).push(listener);
  },
};

function getIpcRegistry() {
  return { handlerMap, listenerMap };
}

module.exports = { ipcMain, getIpcRegistry };
