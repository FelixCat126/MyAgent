import { create } from 'zustand';

type AgentBrowserState = {
  visible: boolean;
  /** 打开时请求的 URL（用于挂载面板；不因重定向改写，避免 webview src 二次导航） */
  url: string;
  /** 页面实际地址（重定向后），仅展示 */
  displayUrl: string;
  title: string;
  loading: boolean;
  open: (url: string, opts?: { visible?: boolean }) => void;
  reveal: () => void;
  /** 只更新展示用 URL/标题，不改写挂载用 url */
  setPageMeta: (url: string, title: string) => void;
  setLoading: (loading: boolean) => void;
  close: () => void;
};

export const useAgentBrowserStore = create<AgentBrowserState>((set) => ({
  visible: false,
  url: '',
  displayUrl: '',
  title: '',
  loading: false,
  open: (url: string, opts?: { visible?: boolean }) =>
    set({
      visible: opts?.visible !== false,
      url,
      displayUrl: url,
      title: '',
      loading: true,
    }),
  reveal: () => set({ visible: true }),
  setPageMeta: (url: string, title: string) =>
    set({
      displayUrl: url || '',
      title: title || '',
      loading: false,
    }),
  setLoading: (loading: boolean) => set({ loading }),
  close: () =>
    set({
      visible: false,
      url: '',
      displayUrl: '',
      title: '',
      loading: false,
    }),
}));
