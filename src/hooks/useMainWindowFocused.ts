import { useEffect, useState } from 'react';

function readDocumentFocused(): boolean {
  if (typeof document === 'undefined') return true;
  return document.hasFocus() && document.visibilityState !== 'hidden';
}

/**
 * 主窗口是否在前台。Electron 首次 show 时 document.hasFocus() 常为 false，
 * 需结合主进程 focus 事件与延迟复检。
 */
export function useMainWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => readDocumentFocused());

  useEffect(() => {
    const sync = (next?: boolean) => {
      setFocused(typeof next === 'boolean' ? next : readDocumentFocused());
    };

    sync();
    const t0 = window.setTimeout(() => sync(), 0);
    const t1 = window.setTimeout(() => sync(), 320);
    const t2 = window.setTimeout(() => sync(), 1200);

    const onFocus = () => sync(true);
    const onBlur = () => sync(false);
    const onVisibility = () => sync();

    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);

    const offElectron = window.electron?.onWindowFocusChanged?.((v) => sync(v));

    return () => {
      clearTimeout(t0);
      clearTimeout(t1);
      clearTimeout(t2);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      offElectron?.();
    };
  }, []);

  return focused;
}
