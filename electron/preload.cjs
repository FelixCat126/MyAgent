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
      cloneForIpc({ messages, config, locale: handlers.locale || 'zh' })
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
  generateImage: (params) => ipcRenderer.invoke('generate-image', cloneForIpc(params)),
  webSearch: (params) => ipcRenderer.invoke('web-search', cloneForIpc(params)),
  extractDocumentText: (arg) => ipcRenderer.invoke('extract-document-text', cloneForIpc(arg)),
  saveAssistantExport: (arg) => ipcRenderer.invoke('save-assistant-export', cloneForIpc(arg)),
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
};
