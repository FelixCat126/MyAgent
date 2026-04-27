import { useCallback } from 'react';
import { t as translate } from '../i18n/ui';
import { useSettingStore } from '../store/settingStore';
import type { Locale } from '../i18n/types';

export function useI18n() {
  const locale = useSettingStore((s) => s.locale);
  const setLocale = useSettingStore((s) => s.setLocale);
  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => translate(locale, key, params),
    [locale]
  );
  return { t, locale, setLocale };
}

export function tStatic(locale: Locale, key: string, params?: Record<string, string | number>): string {
  return translate(locale, key, params);
}
