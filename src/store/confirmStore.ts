import { create } from 'zustand';

type PendingConfirm = {
  message: string;
  resolve: (ok: boolean) => void;
};

interface ConfirmStore {
  pending: PendingConfirm | null;
  ask: (message: string) => Promise<boolean>;
  settle: (ok: boolean) => void;
}

export const useConfirmStore = create<ConfirmStore>((set, get) => ({
  pending: null,
  ask: (message) =>
    new Promise<boolean>((resolve) => {
      const prev = get().pending;
      if (prev) prev.resolve(false);
      set({ pending: { message, resolve } });
    }),
  settle: (ok) => {
    const p = get().pending;
    if (!p) return;
    set({ pending: null });
    p.resolve(ok);
  },
}));

/** 破坏性操作确认（自定义对话框；调用点统一走此 API） */
export function confirmDestructive(message: string): Promise<boolean> {
  return useConfirmStore.getState().ask(message);
}
