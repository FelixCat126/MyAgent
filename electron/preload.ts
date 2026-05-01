import { contextBridge, ipcRenderer } from 'electron';
import { cloneForIpc } from './ipcClone';

// 向渲染进程暴露安全的 API（入参一律 clone，避免 Structured Clone 失败）
contextBridge.exposeInMainWorld('electron', {
  sendMessage: (channel: string, data: unknown) =>
    ipcRenderer.send(channel, data == null ? null : cloneForIpc(data)),
  onMessage: (channel: string, func: (...args: unknown[]) => void) => {
    ipcRenderer.on(channel, (_event: Electron.IpcRendererEvent, ...args: unknown[]) => func(...args));
  },

  callModel: (messages: unknown[], config: unknown) =>
    ipcRenderer.invoke('call-model', cloneForIpc(messages), cloneForIpc(config)),

  uploadFile: (fileData: unknown) => ipcRenderer.invoke('upload-file', cloneForIpc(fileData)),

  launchApp: (appName: string) => ipcRenderer.invoke('launch-app', cloneForIpc(appName)),

  getInstalledApps: () => ipcRenderer.invoke('get-installed-apps'),

  generateImage: (params: unknown) => ipcRenderer.invoke('generate-image', cloneForIpc(params)),

  webSearch: (params: unknown) => ipcRenderer.invoke('web-search', cloneForIpc(params)),

  saveLocalFileCopy: (params: unknown) =>
    ipcRenderer.invoke('save-local-file-copy', cloneForIpc(params)),
});
