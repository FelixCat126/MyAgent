import { create } from 'zustand';

export type ErrorLevel = 'error' | 'warning' | 'success' | 'info';

export interface ErrorItem {
  id: number;
  level: ErrorLevel;
  /** i18n key in ui.ts */
  key: string;
  /** Variables for i18n template substitution */
  params?: Record<string, string | number>;
  /** Auto-dismiss in ms (0 = sticky) */
  durationMs: number;
}

interface ErrorStoreState {
  items: ErrorItem[];
  /** Push a new toast; auto-assigns id and default duration */
  show: (level: ErrorLevel, key: string, params?: Record<string, string | number>, durationMs?: number) => number;
  dismiss: (id: number) => void;
  clear: () => void;
}

let counter = 0;
const nextId = () => ++counter;

const DEFAULT_DURATION: Record<ErrorLevel, number> = {
  error: 5000,
  warning: 4000,
  success: 2500,
  info: 3500,
};

export const useErrorStore = create<ErrorStoreState>((set) => ({
  items: [],
  show: (level, key, params, durationMs) => {
    const id = nextId();
    const item: ErrorItem = {
      id,
      level,
      key,
      params,
      durationMs: durationMs ?? DEFAULT_DURATION[level],
    };
    set((s) => ({ items: [...s.items, item] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((it) => it.id !== id) })),
  clear: () => set({ items: [] }),
}));

/** Convenience helpers for the most common cases. */
export const showError = (key: string, params?: Record<string, string | number>) =>
  useErrorStore.getState().show('error', key, params);
export const showWarning = (key: string, params?: Record<string, string | number>) =>
  useErrorStore.getState().show('warning', key, params);
export const showSuccess = (key: string, params?: Record<string, string | number>) =>
  useErrorStore.getState().show('success', key, params);
export const showInfo = (key: string, params?: Record<string, string | number>) =>
  useErrorStore.getState().show('info', key, params);
export const dismissError = (id: number) => useErrorStore.getState().dismiss(id);
export const clearErrors = () => useErrorStore.getState().clear();
