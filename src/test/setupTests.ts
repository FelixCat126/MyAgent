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
}
