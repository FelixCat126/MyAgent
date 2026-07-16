import { useCallback } from 'react';
import {
  useErrorStore,
  showError,
  showWarning,
  showSuccess,
  showInfo,
  dismissError,
  clearErrors,
  type ErrorLevel,
} from '../store/errorStore';

/** Stable callback-returning hook for components that want fire-and-forget error toasts. */
export function useErrorToast() {
  const show = useCallback(
    (level: ErrorLevel, key: string, params?: Record<string, string | number>, durationMs?: number) =>
      useErrorStore.getState().show(level, key, params, durationMs),
    []
  );
  return {
    show,
    showError,
    showWarning,
    showSuccess,
    showInfo,
    dismiss: dismissError,
    clear: clearErrors,
  };
}
