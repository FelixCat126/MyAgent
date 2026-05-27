import { useEffect, useState } from 'react';
import { detectSystemTtsAvailable, getSystemTtsAvailableCached } from '@/utils/systemTts';

/**
 * 启动时检测本机系统 TTS（Web Speech + 当前语言语音包）。
 * null = 检测中；false = 不可用；true = 可用。
 */
export function useSystemTtsAvailable(uiLocale: string): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(() => getSystemTtsAvailableCached());

  useEffect(() => {
    let cancelled = false;
    void detectSystemTtsAvailable(uiLocale).then((ok) => {
      if (!cancelled) setAvailable(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [uiLocale]);

  return available;
}
