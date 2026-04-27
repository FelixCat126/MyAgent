import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSettingStore } from './settingStore';

function reset() {
  localStorage.removeItem('setting-storage');
  useSettingStore.setState({
    theme: 'light',
    fontSize: 14,
    autoSave: true,
    streamResponses: true,
    locale: 'zh',
  });
  document.body.classList.remove('dark');
}

describe('settingStore', () => {
  beforeEach(() => {
    reset();
  });
  afterEach(() => {
    document.body.classList.remove('dark');
  });

  it('setStreamResponses 与 setFontSize、setAutoSave', () => {
    useSettingStore.getState().setStreamResponses(false);
    expect(useSettingStore.getState().streamResponses).toBe(false);
    useSettingStore.getState().setFontSize(16);
    expect(useSettingStore.getState().fontSize).toBe(16);
    useSettingStore.getState().setAutoSave(false);
    expect(useSettingStore.getState().autoSave).toBe(false);
  });

  it('setTheme dark 时 body 有 dark 类，light 时移除', () => {
    useSettingStore.getState().setTheme('dark');
    expect(document.body.classList.contains('dark')).toBe(true);
    useSettingStore.getState().setTheme('light');
    expect(document.body.classList.contains('dark')).toBe(false);
  });
});
