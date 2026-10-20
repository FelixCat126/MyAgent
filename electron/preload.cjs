// Preload：必须在任何页面脚本之前运行，全局包装 ipcRenderer，避免 Structured Clone 报错
const { contextBridge, ipcRenderer } = require('electron');

function isBinary(v) {
  return v instanceof ArrayBuffer || ArrayBuffer.isView(v);
}

/** 二进制须原样走结构化克隆：JSON 往返会把 Uint8Array 变成下标对象 */
function cloneForIpc(v) {
  if (v === undefined || v === null) return v;
  if (isBinary(v)) return v;
  if (typeof v === 'object' && !Array.isArray(v)) {
    const binaryKeys = Object.keys(v).filter((k) => isBinary(v[k]));
    if (binaryKeys.length > 0) {
      const rest = { ...v };
      for (const k of binaryKeys) delete rest[k];
      const cleaned = cloneForIpc(rest) ?? {};
      for (const k of binaryKeys) cleaned[k] = v[k];
      return cleaned;
    }
  }
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

/** 通用 send/on 仅放行显式列出的通道，其余主进程通道须走下方具名方法 */
const SEND_MESSAGE_CHANNELS = new Set([]);
const ON_MESSAGE_CHANNELS = new Set([
  'model-agent-thinking',
  'myagent-clipboard-paste',
  'volc-asr-text',
  'volc-asr-error',
  'volc-asr-ended',
]);

const api = {
  /** 注：invoke/send 已在上方 patch 中统一 cloneForIpc，各方法无需再克隆 */
  sendMessage: (channel, data) => {
    if (!SEND_MESSAGE_CHANNELS.has(channel)) throw new Error(`IPC 通道未授权: ${channel}`);
    ipcRenderer.send(channel, data);
  },
  onMessage: (channel, func) => {
    if (!ON_MESSAGE_CHANNELS.has(channel)) throw new Error(`IPC 通道未授权: ${channel}`);
    const handler = (_event, ...args) => func(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  callModel: (messages, config, options) =>
    ipcRenderer.invoke('call-model', messages, config, options ?? null),
  subscribeModelStream: (messages, config, handlers) => {
    /** 同一窗口可并行多条流；主进程事件末尾带 streamId，只处理属于本订阅的事件 */
    const streamId = `ms-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const d = (_e, t, id) => {
      if (id === streamId) handlers.onDelta(t);
    };
    const think = (_e, t, id) => {
      if (id === streamId && handlers.onThinkingDelta) handlers.onThinkingDelta(t);
    };
    const err = (_e, m, id) => {
      if (id !== streamId || ended) return;
      try { handlers.onError(m); } finally { finish(); }

    };
    let ended = false;
    const cleanup = () => {
      if (ended) return;
      ended = true;
      ipcRenderer.removeListener('model-stream-delta', d);
      ipcRenderer.removeListener('model-stream-thinking-delta', think);
      ipcRenderer.removeListener('model-stream-error', err);
      ipcRenderer.removeListener('model-stream-end', end);
    };
    const finish = () => {
      if (ended) return;
      cleanup();
      handlers.onEnd();
    };
    const end = (_e, id) => {
      if (id === streamId) finish();
    };
    ipcRenderer.on('model-stream-delta', d);
    ipcRenderer.on('model-stream-thinking-delta', think);
    ipcRenderer.on('model-stream-error', err);
    ipcRenderer.on('model-stream-end', end);
    ipcRenderer.send('model-stream-start', {
      messages,
      config,
      streamId,
      locale: handlers.locale || 'zh',
      ...(typeof handlers.temperature === 'number' ? { temperature: handlers.temperature } : {}),
    });
    return () => {
      ipcRenderer.send('model-stream-abort', streamId);
    };
  },
  /** 不带参数：中止本窗口全部模型流 */
  closeModelStream: () => ipcRenderer.send('model-stream-abort'),
  cancelImageGeneration: (requestId) => ipcRenderer.send('image-generation-cancel', requestId),
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
    return ipcRenderer.invoke('generate-image', payload).finally(() => {
      if (imageHandler) ipcRenderer.removeListener('image-generation-image', imageHandler);
    });
  },
  webSearch: (params) => ipcRenderer.invoke('web-search', params),
  agentWebRead: (arg) => ipcRenderer.invoke('agent-web-read', arg ?? null),
  listMediaLibraryImages: (arg) =>
    ipcRenderer.invoke('list-media-library-images', arg ?? null),
  persistGet: (name) => ipcRenderer.invoke('persist-state-get', name),
  persistSet: (name, value) => ipcRenderer.invoke('persist-state-set', { name, value }),
  persistGetSync: (name) => {
    const v = ipcRenderer.sendSync('persist-state-get-sync', name);
    return v === undefined || v === null ? null : String(v);
  },
  persistSetSync: (name, value) => {
    ipcRenderer.send('persist-state-set-sync', name, value);
  },
  persistChatWrite: (payload) => ipcRenderer.invoke('persist-chat-write', payload),
  persistChatWriteSync: (payload) => {
    ipcRenderer.send('persist-chat-write-sync', payload);
  },
  capturePageToClipboard: () => ipcRenderer.invoke('capture-page-to-clipboard'),
  generateVideo: (params, handlers) => {
    const requestId =
      (params && typeof params.streamRequestId === 'string' && params.streamRequestId) ||
      `vid-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const payload = { ...(params || {}), streamRequestId: requestId };
    let progressHandler = null;
    if (handlers && typeof handlers.onProgress === 'function') {
      progressHandler = (_event, eventPayload) => {
        if (!eventPayload || eventPayload.requestId !== requestId) return;
        handlers.onProgress(eventPayload);
      };
      ipcRenderer.on('video-generation-progress', progressHandler);
    }
    return ipcRenderer.invoke('api:generate-video', payload).finally(() => {
      if (progressHandler) ipcRenderer.removeListener('video-generation-progress', progressHandler);
    });
  },
  readVideoAsDataUrl: (filePath) => ipcRenderer.invoke('api:read-video', filePath),
  cancelVideo: (taskId) => ipcRenderer.invoke('api:cancel-video', taskId),
  getLocalFileSize: (filePath) => ipcRenderer.invoke('app:get-local-file-size', filePath),
  onWindowFocusChanged: (func) => {
    const handler = (_event, focused) => func(Boolean(focused));
    ipcRenderer.on('window-focus-changed', handler);
    return () => ipcRenderer.removeListener('window-focus-changed', handler);
  },
   log: (payload) => ipcRenderer.send('app:log', payload),
  getHealth: () => ipcRenderer.invoke('app:get-health'),
  getStats: () => ipcRenderer.invoke('app:get-stats'),
  exportSession: (arg) => ipcRenderer.invoke('session:export', arg),
};

/** 纯转发 invoke 通道表：方法名 → 通道名（含事件逻辑/参数整形的已在上文手写） */
const INVOKE_CHANNELS = {
  saveTextFile: 'save-text-file',
  saveLocalFileCopy: 'save-local-file-copy',
  importTextFile: 'import-text-file',
  readTextFileAbsolute: 'read-text-file-absolute',
  readWorkspaceHint: 'read-workspace-hint',
  getClipboardText: 'get-clipboard-text',
  setClipboardText: 'set-clipboard-text',
  uploadFile: 'upload-file',
  openLocalFile: 'open-local-file',
  launchApp: 'launch-app',
  getInstalledApps: 'get-installed-apps',
  extractDocumentText: 'extract-document-text',
  saveAssistantExport: 'save-assistant-export',
  createDocumentArtifact: 'create-document-artifact',
  agentLocalList: 'agent-local-list',
  agentLocalFindByName: 'agent-local-find-by-name',
  agentLocalRead: 'agent-local-read',
  agentWebOpen: 'agent-web-open',
  agentWebEval: 'agent-web-eval',
  agentWebClose: 'agent-web-close',
  agentWebSaveRemoteImage: 'agent-web-save-remote-image',
  knowledgeIndexWorkspace: 'knowledge-index-workspace',
  knowledgeSearch: 'knowledge-search',
  knowledgeGetIndexStatus: 'knowledge-index-status',
  persistRemove: 'persist-state-remove',
  persistClearAll: 'persist-state-clear-all',
  transcribeAudio: 'transcribe-audio-openai',
  volcAsrStart: 'volc-asr-start',
  volcAsrPushChunk: 'volc-asr-chunk',
  volcAsrFinish: 'volc-asr-finish',
  volcAsrAbort: 'volc-asr-abort',
  deleteMediaLibraryImage: 'delete-media-library-image',
  remoteGatewayGetConfig: 'remote-gateway-get-config',
  remoteGatewaySetConfig: 'remote-gateway-set-config',
  getGestureModelData: 'get-gesture-model-data',
  getFaceModelData: 'get-face-model-data',
  ensureCameraAccess: 'ensure-camera-access',
  openCameraPrivacySettings: 'open-camera-privacy-settings',
  simulateGazeMove: 'simulate-gaze-move',
  simulateGazeClick: 'simulate-gaze-click',
  simulateGazeWheel: 'simulate-gaze-wheel',
};

for (const [method, channel] of Object.entries(INVOKE_CHANNELS)) {
  api[method] = (...args) => ipcRenderer.invoke(channel, ...args);
}

Object.assign(api, require('./preload-runtime.cjs').createRuntimeApi(ipcRenderer), require('./preload-voice-quick.cjs').createVoiceQuickApi(ipcRenderer), require('./preload-media.cjs').createMediaWorkbenchApi(ipcRenderer), require('./preload-documents.cjs').createDocumentWorkbenchApi(ipcRenderer), {
  discoverServiceModels: (config) => ipcRenderer.invoke('model-service:discover', config),
  diagnoseModel: (config, checks) => ipcRenderer.invoke('model-service:diagnose', config, checks),
  callAgentModel: (arg) => ipcRenderer.invoke('model-service:agent', arg),
  abortAgentModel: (requestId) => ipcRenderer.send('model-service:abort', requestId),
});

if (process.contextIsolated) contextBridge.exposeInMainWorld('electron', api);
else window.electron = api;
