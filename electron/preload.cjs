// Preload：必须在任何页面脚本之前运行，全局包装 ipcRenderer，避免 Structured Clone 报错
const { ipcRenderer } = require('electron');

function cloneForIpc(v) {
  if (v === undefined || v === null) return v;
  try {
    const s = JSON.stringify(v);
    if (s === undefined) return undefined;
    return JSON.parse(s);
  } catch (e) {
    console.warn('[cloneForIpc]', e);
    return null;
  }
}

(function patchIpcRenderer() {
  const rawSend = ipcRenderer.send.bind(ipcRenderer);
  ipcRenderer.send = function patchedSend(channel, ...args) {
    const cleaned = args.map((a) => (a === undefined || a === null ? a : cloneForIpc(a)));
    return rawSend(channel, ...cleaned);
  };
  const rawInvoke = ipcRenderer.invoke.bind(ipcRenderer);
  ipcRenderer.invoke = function patchedInvoke(channel, ...args) {
    const cleaned = args.map((a) => (a === undefined || a === null ? a : cloneForIpc(a)));
    return rawInvoke(channel, ...cleaned);
  };
})();

window.electron = {
  sendMessage: (channel, data) =>
    ipcRenderer.send(channel, data == null ? null : cloneForIpc(data)),
  onMessage: (channel, func) => {
    const handler = (_event, ...args) => func(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  callModel: (messages, config, options) =>
    ipcRenderer.invoke('call-model', cloneForIpc(messages), cloneForIpc(config), cloneForIpc(options ?? null)),
  subscribeModelStream: (messages, config, handlers) => {
    const d = (_e, t) => handlers.onDelta(t);
    const think = (_e, t) => {
      if (handlers.onThinkingDelta) handlers.onThinkingDelta(t);
    };
    const err = (_e, m) => handlers.onError(m);
    let ended = false;
    const cleanup = () => {
      if (ended) return;
      ended = true;
      ipcRenderer.removeListener('model-stream-delta', d);
      ipcRenderer.removeListener('model-stream-thinking-delta', think);
      ipcRenderer.removeListener('model-stream-error', err);
      ipcRenderer.removeListener('model-stream-end', end);
    };
    const end = () => {
      cleanup();
      handlers.onEnd();
    };
    ipcRenderer.on('model-stream-delta', d);
    ipcRenderer.on('model-stream-thinking-delta', think);
    ipcRenderer.on('model-stream-error', err);
    ipcRenderer.on('model-stream-end', end);
    ipcRenderer.send(
      'model-stream-start',
      cloneForIpc({
        messages,
        config,
        locale: handlers.locale || 'zh',
        ...(typeof handlers.temperature === 'number' ? { temperature: handlers.temperature } : {}),
      })
    );
    return () => {
      ipcRenderer.send('model-stream-abort');
    };
  },
  closeModelStream: () => ipcRenderer.send('model-stream-abort'),
  saveTextFile: (arg) => ipcRenderer.invoke('save-text-file', cloneForIpc(arg)),
  saveLocalFileCopy: (arg) => ipcRenderer.invoke('save-local-file-copy', cloneForIpc(arg)),
  importTextFile: () => ipcRenderer.invoke('import-text-file'),
  readTextFileAbsolute: (p) => ipcRenderer.invoke('read-text-file-absolute', cloneForIpc(p)),
  readWorkspaceHint: (arg) => ipcRenderer.invoke('read-workspace-hint', cloneForIpc(arg)),
  getClipboardText: () => ipcRenderer.invoke('get-clipboard-text'),
  setClipboardText: (t) => ipcRenderer.invoke('set-clipboard-text', cloneForIpc(t)),
  uploadFile: (fileData) => ipcRenderer.invoke('upload-file', cloneForIpc(fileData)),
  launchApp: (appName) => ipcRenderer.invoke('launch-app', cloneForIpc(appName)),
  getInstalledApps: () => ipcRenderer.invoke('get-installed-apps'),
  generateImage: (params, handlers) => {
    const requestId =
      (params && typeof params.streamRequestId === 'string' && params.streamRequestId) ||
      `img-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const payload = { ...(params || {}), streamRequestId: requestId };
    let imageHandler = null;
    if (handlers && typeof handlers.onImage === 'function') {
      imageHandler = (_event, eventPayload) => {
        if (!eventPayload || eventPayload.requestId !== requestId) return;
        handlers.onImage(eventPayload);
      };
      ipcRenderer.on('image-generation-image', imageHandler);
    }
    return ipcRenderer.invoke('generate-image', cloneForIpc(payload)).finally(() => {
      if (imageHandler) ipcRenderer.removeListener('image-generation-image', imageHandler);
    });
  },
  webSearch: (params) => ipcRenderer.invoke('web-search', cloneForIpc(params)),
  extractDocumentText: (arg) => ipcRenderer.invoke('extract-document-text', cloneForIpc(arg)),
  saveAssistantExport: (arg) => ipcRenderer.invoke('save-assistant-export', cloneForIpc(arg)),
  createDocumentArtifact: (arg) => ipcRenderer.invoke('create-document-artifact', cloneForIpc(arg)),
  agentLocalList: (arg) => ipcRenderer.invoke('agent-local-list', cloneForIpc(arg)),
  agentLocalFindByName: (arg) => ipcRenderer.invoke('agent-local-find-by-name', cloneForIpc(arg)),
  agentLocalRead: (arg) => ipcRenderer.invoke('agent-local-read', cloneForIpc(arg)),
  agentWebOpen: (arg) => ipcRenderer.invoke('agent-web-open', cloneForIpc(arg)),
  agentWebRead: (arg) => ipcRenderer.invoke('agent-web-read', cloneForIpc(arg ?? null)),
  agentWebEval: (arg) => ipcRenderer.invoke('agent-web-eval', cloneForIpc(arg)),
  agentWebClose: () => ipcRenderer.invoke('agent-web-close'),
  knowledgeIndexWorkspace: (arg) => ipcRenderer.invoke('knowledge-index-workspace', cloneForIpc(arg)),
  knowledgeSearch: (arg) => ipcRenderer.invoke('knowledge-search', cloneForIpc(arg)),
  knowledgeGetIndexStatus: () => ipcRenderer.invoke('knowledge-index-status'),
  persistGet: (name) => ipcRenderer.invoke('persist-state-get', name),
  persistSet: (name, value) => ipcRenderer.invoke('persist-state-set', cloneForIpc({ name, value })),
  persistRemove: (name) => ipcRenderer.invoke('persist-state-remove', name),
  persistClearAll: () => ipcRenderer.invoke('persist-state-clear-all'),
  persistGetSync: (name) => {
    const v = ipcRenderer.sendSync('persist-state-get-sync', name);
    return v === undefined || v === null ? null : String(v);
  },
  persistSetSync: (name, value) => {
    ipcRenderer.send('persist-state-set-sync', name, value);
  },
  transcribeAudio: (arg) => ipcRenderer.invoke('transcribe-audio-openai', cloneForIpc(arg)),
  volcAsrStart: (arg) => ipcRenderer.invoke('volc-asr-start', cloneForIpc(arg)),
  volcAsrPushChunk: (arr) => ipcRenderer.invoke('volc-asr-chunk', cloneForIpc(arr)),
  volcAsrFinish: () => ipcRenderer.invoke('volc-asr-finish'),
  volcAsrAbort: () => ipcRenderer.invoke('volc-asr-abort'),
  listMediaLibraryImages: (arg) =>
    ipcRenderer.invoke('list-media-library-images', cloneForIpc(arg ?? null)),
  deleteMediaLibraryImage: (arg) =>
    ipcRenderer.invoke('delete-media-library-image', cloneForIpc(arg)),
  remoteGatewayGetConfig: () => ipcRenderer.invoke('remote-gateway-get-config'),
  remoteGatewaySetConfig: (patch) =>
    ipcRenderer.invoke('remote-gateway-set-config', cloneForIpc(patch)),
  getGestureModelData: () => ipcRenderer.invoke('get-gesture-model-data'),
  getFaceModelData: () => ipcRenderer.invoke('get-face-model-data'),
  simulateGazeMove: (x, y) => ipcRenderer.invoke('simulate-gaze-move', x, y),
  simulateGazeClick: (x, y) => ipcRenderer.invoke('simulate-gaze-click', x, y),
  simulateGazeWheel: (x, y, deltaY) => ipcRenderer.invoke('simulate-gaze-wheel', x, y, deltaY),
  capturePageToClipboard: () => ipcRenderer.invoke('capture-page-to-clipboard'),
  onWindowFocusChanged: (func) => {
    const handler = (_event, focused) => func(Boolean(focused));
    ipcRenderer.on('window-focus-changed', handler);
    return () => ipcRenderer.removeListener('window-focus-changed', handler);
  },
};
