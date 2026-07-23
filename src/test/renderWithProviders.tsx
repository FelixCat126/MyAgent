/**
 * 测试用渲染器：t 函数统一注入（用 store 当前 locale），并套上 future 通用 Provider。
 * 避免每个组件测试都重复 `render(<X t={tStatic} />)`，又与生产 useI18n 行为不一致。
 */
import type { ReactElement } from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { t as translateRaw } from '../i18n/ui';
import { useSettingStore } from '../store/settingStore';

export type RenderWithProvidersOptions = Omit<RenderOptions, 'wrapper'>;

/**
 * 用当前 store locale 柯里化出一个 `(key, params) => string`，供 props-injected t
 * 类组件（如 ModelsSection）测试使用。等价于该组件内的 `const { t } = useI18n()`。
 */
export function makeT(locale: 'zh' | 'en' = 'zh') {
  return (key: string, params?: Record<string, string | number>) =>
    translateRaw(locale, key, params);
}

export function renderWithProviders(
  ui: ReactElement,
  opts?: RenderWithProvidersOptions & { locale?: 'zh' | 'en' }
) {
  if (opts?.locale) useSettingStore.getState(); // 触发读取（若未来 locale 切换需要持久化联动）
  return render(ui, opts);
}

export { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
export { makeT as makeTFor };
