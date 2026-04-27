import { useEffect, useState } from 'react';
import { useSettingStore } from '../store/settingStore';

function getSystemDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** theme 为 system 时跟随 prefers-color-scheme，否则为 light / dark */
export function useResolvedTheme(): 'light' | 'dark' {
  const theme = useSettingStore((s) => s.theme);
  const [osDark, setOsDark] = useState(getSystemDark);

  useEffect(() => {
    if (theme !== 'system') return;
    const m = window.matchMedia('(prefers-color-scheme: dark)');
    const fn = () => setOsDark(m.matches);
    m.addEventListener('change', fn);
    setOsDark(m.matches);
    return () => m.removeEventListener('change', fn);
  }, [theme]);

  if (theme === 'system') {
    return osDark ? 'dark' : 'light';
  }
  return theme;
}
