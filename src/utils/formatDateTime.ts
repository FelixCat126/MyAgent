import type { Locale } from '../i18n/types';

/** 统一日期时间展示：24 小时制，避免英文 AM/PM 折行 */
export function formatDateTime(ts: number, locale: Locale = 'zh'): string {
  return new Date(ts).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
