import '@testing-library/jest-dom/vitest';
import type { ElectronAPI } from '../types';

/** 测试环境无 Electron preload，提供最小 stub 避免 ChatWindow 等报错 */
const electronStub: ElectronAPI = {
  sendMessage: () => {},
  onMessage: () => () => {},
  callModel: async () => ({ content: '' }),
  subscribeModelStream: () => () => {},
  closeModelStream: () => {},
  saveTextFile: async () => ({ ok: false }),
  importTextFile: async () => ({ ok: false }),
  readTextFileAbsolute: async () => ({ ok: false }),
  readWorkspaceHint: async () => ({ ok: false }),
  getClipboardText: async () => '',
  setClipboardText: async () => true,
  uploadFile: async () => ({ name: '', path: '', type: '', size: 0 }),
  launchApp: async () => true,
  getInstalledApps: async () => [],
  generateImage: async () => [{ url: '', path: '', width: 0, height: 0 }],
  webSearch: async () => ({ ok: false, text: '' }),
  extractDocumentText: async () => ({ ok: true, text: '', kind: 'test' }),
  saveAssistantExport: async () => ({ ok: false }),
  createDocumentArtifact: async () => ({ ok: false }),
  saveLocalFileCopy: async () => ({ ok: false }),
  knowledgeIndexWorkspace: async () => ({ ok: false, error: 'stub' }),
  knowledgeSearch: async () => ({ ok: false, error: 'stub' }),
  knowledgeGetIndexStatus: async () => ({
    ok: true,
    chunkCount: 0,
    root: null,
    model: null,
    updatedAt: 0,
  }),
  persistGet: async (name) => localStorage.getItem(name),
  persistSet: async (name, value) => {
    localStorage.setItem(name, value);
  },
  persistRemove: async (name) => {
    localStorage.removeItem(name);
  },
  persistClearAll: async () => {
    localStorage.clear();
  },
  persistGetSync: (name) => localStorage.getItem(name),
  persistSetSync: (name, value) => {
    localStorage.setItem(name, value);
  },
  listMediaLibraryImages: async () => ({ ok: true, items: [] }),
  deleteMediaLibraryImage: async () => ({ ok: true }),
  transcribeAudio: async () => ({ ok: false, error: 'stub' }),
  volcAsrStart: async () => ({ ok: false, error: 'stub' }),
  volcAsrPushChunk: async () => ({ ok: false }),
  volcAsrFinish: async () => ({ ok: false }),
  volcAsrAbort: async () => ({ ok: false }),
  remoteGatewayGetConfig: async () => ({
    enabled: false,
    port: 9742,
    token: 'stub-token',
  }),
  remoteGatewaySetConfig: async (patch) => ({
    enabled: typeof patch?.enabled === 'boolean' ? patch.enabled : false,
    port: typeof patch?.port === 'number' ? patch.port : 9742,
    token: 'stub-token',
  }),
};

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'electron', {
    writable: true,
    configurable: true,
    value: electronStub,
  });

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });

  /** jsdom 未实现 Blob 的 URL.createObjectURL，附件下载等 DOM 链路需占位 */
  const UrlStatic = window.URL as unknown as Record<string, unknown>;
  if (typeof UrlStatic.createObjectURL !== 'function') {
    UrlStatic.createObjectURL = (): string =>
      typeof crypto.randomUUID === 'function'
        ? `blob:vitest-${crypto.randomUUID()}`
        : `blob:vitest-${Math.random().toString(36).slice(2)}`;
    UrlStatic.revokeObjectURL = (): void => {};
  }
}
