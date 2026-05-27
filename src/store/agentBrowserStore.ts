import { create } from 'zustand';

type AgentBrowserState = {
  visible: boolean;
  url: string;
  title: string;
  loading: boolean;
  open: (url: string, opts?: { visible?: boolean }) => void;
  reveal: () => void;
  setPageMeta: (url: string, title: string) => void;
  setLoading: (loading: boolean) => void;
  close: () => void;
};

export const useAgentBrowserStore = create<AgentBrowserState>((set) => ({
  visible: false,
  url: '',
  title: '',
  loading: false,
  open: (url: string, opts?: { visible?: boolean }) =>
    set({
      visible: opts?.visible !== false,
      url,
      title: '',
      loading: true,
    }),
  reveal: () => set({ visible: true }),
  setPageMeta: (url: string, title: string) =>
    set({
      url: url || '',
      title: title || '',
      loading: false,
    }),
  setLoading: (loading: boolean) => set({ loading }),
  close: () =>
    set({
      visible: false,
      url: '',
      title: '',
      loading: false,
    }),
}));
