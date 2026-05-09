/**
 * 手动注入的 Preload 脚本
 * 在 main.ts 中通过 webContents.executeJavaScript 注入
 */

export const preloadScript = `
  const { contextBridge, ipcRenderer } = require('electron');
  function __cf(v) {
    try {
      const s = JSON.stringify(v);
      if (s === undefined) return undefined;
      return JSON.parse(s);
    } catch (e) {
      console.warn('[IPC clone]', e);
      return null;
    }
  }
  contextBridge.exposeInMainWorld('electron', {
    sendMessage: (channel, data) => ipcRenderer.send(channel, data == null ? null : __cf(data)),
    onMessage: (channel, func) => {
      ipcRenderer.on(channel, (_event, ...args) => func(...args));
    },
    callModel: (messages, config) => ipcRenderer.invoke('call-model', __cf(messages), __cf(config)),
    uploadFile: (fileData) => ipcRenderer.invoke('upload-file', __cf(fileData)),
    launchApp: (appName) => ipcRenderer.invoke('launch-app', __cf(appName)),
    getInstalledApps: () => ipcRenderer.invoke('get-installed-apps'),
    generateImage: (params, handlers) => {
      const requestId =
        (params && typeof params.streamRequestId === 'string' && params.streamRequestId) ||
        \`img-\${Date.now()}-\${Math.random().toString(16).slice(2)}\`;
      const payload = { ...(params || {}), streamRequestId: requestId };
      let imageHandler = null;
      if (handlers && typeof handlers.onImage === 'function') {
        imageHandler = (_event, eventPayload) => {
          if (!eventPayload || eventPayload.requestId !== requestId) return;
          handlers.onImage(eventPayload);
        };
        ipcRenderer.on('image-generation-image', imageHandler);
      }
      return ipcRenderer.invoke('generate-image', __cf(payload)).finally(() => {
        if (imageHandler) ipcRenderer.removeListener('image-generation-image', imageHandler);
      });
    },
    webSearch: (params) => ipcRenderer.invoke('web-search', __cf(params)),
  });
`;
