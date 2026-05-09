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

  generateImage: (
    params: Record<string, unknown>,
    handlers?: {
      onImage?: (p: {
        requestId: string;
        image: { url: string; path: string; width: number; height: number };
        index: number;
        total: number;
      }) => void;
    }
  ) => {
    const requestId =
      (typeof params?.streamRequestId === 'string' && params.streamRequestId) ||
      `img-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const payload = { ...(params || {}), streamRequestId: requestId };
    let imageHandler: ((event: Electron.IpcRendererEvent, payload: unknown) => void) | null = null;
    if (handlers?.onImage) {
      imageHandler = (_event, eventPayload) => {
        const p = eventPayload as { requestId?: string } | undefined;
        if (!p || p.requestId !== requestId) return;
        handlers.onImage?.(eventPayload as {
          requestId: string;
          image: { url: string; path: string; width: number; height: number };
          index: number;
          total: number;
        });
      };
      ipcRenderer.on('image-generation-image', imageHandler);
    }
    return ipcRenderer.invoke('generate-image', cloneForIpc(payload)).finally(() => {
      if (imageHandler) ipcRenderer.removeListener('image-generation-image', imageHandler);
    });
  },

  webSearch: (params: unknown) => ipcRenderer.invoke('web-search', cloneForIpc(params)),

  saveLocalFileCopy: (params: unknown) =>
    ipcRenderer.invoke('save-local-file-copy', cloneForIpc(params)),
  createDocumentArtifact: (arg: unknown) =>
    ipcRenderer.invoke('create-document-artifact', cloneForIpc(arg)),
});
