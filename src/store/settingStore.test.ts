import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSettingStore } from './settingStore';
import { PERSIST_KEYS } from '../utils/persistKeys';

function reset() {
  localStorage.removeItem(PERSIST_KEYS.setting);
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

  it('setLocale 切换 zh / en', () => {
    expect(useSettingStore.getState().locale).toBe('zh');
    useSettingStore.getState().setLocale('en');
    expect(useSettingStore.getState().locale).toBe('en');
    useSettingStore.getState().setLocale('zh');
    expect(useSettingStore.getState().locale).toBe('zh');
  });

  it('setTheme system 时移除 dark 类（取决于 prefers-color-scheme）', () => {
    /** jsdom 不模拟 prefers-color-scheme，setTheme('system') 行为：清空 dark，依赖 CSS media query */
    useSettingStore.getState().setTheme('dark');
    expect(document.body.classList.contains('dark')).toBe(true);
    useSettingStore.getState().setTheme('system');
    expect(document.body.classList.contains('dark')).toBe(false);
  });

  it('setSpeechInputEnabled / setVoiceWakeEnabled / setVoiceReplyEnabled 状态切换', () => {
    useSettingStore.getState().setSpeechInputEnabled(false);
    expect(useSettingStore.getState().speechInputEnabled).toBe(false);
    useSettingStore.getState().setVoiceWakeEnabled(true);
    expect(useSettingStore.getState().voiceWakeEnabled).toBe(true);
    useSettingStore.getState().setVoiceReplyEnabled(true);
    expect(useSettingStore.getState().voiceReplyEnabled).toBe(true);
  });

  it('setVoiceWakePhrase 存字符串', () => {
    useSettingStore.getState().setVoiceWakePhrase('小园小园');
    expect(useSettingStore.getState().voiceWakePhrase).toBe('小园小园');
  });

  it('setVolcAsr 三字段独立持久', () => {
    useSettingStore.getState().setVolcAsrAppKey('a');
    useSettingStore.getState().setVolcAsrAccessKey('b');
    useSettingStore.getState().setVolcAsrResourceId('c');
    expect(useSettingStore.getState().volcAsrAppKey).toBe('a');
    expect(useSettingStore.getState().volcAsrAccessKey).toBe('b');
    expect(useSettingStore.getState().volcAsrResourceId).toBe('c');
  });

  it('setGestureControlEnabled / setAgentLocalToolsEnabled / setAgentBrowserEnabled 状态切换', () => {
    useSettingStore.getState().setGestureControlEnabled(true);
    useSettingStore.getState().setAgentLocalToolsEnabled(true);
    useSettingStore.getState().setAgentBrowserEnabled(false);
    expect(useSettingStore.getState().gestureControlEnabled).toBe(true);
    expect(useSettingStore.getState().agentLocalToolsEnabled).toBe(true);
    expect(useSettingStore.getState().agentBrowserEnabled).toBe(false);
  });

  it('setAgentDeniedPaths 去重 + 过滤空串', () => {
    useSettingStore.getState().setAgentDeniedPaths(['/a', '/b', '/a', '', '  ']);
    expect(useSettingStore.getState().agentDeniedPaths).toEqual(['/a', '/b']);
  });

  it('setParticleFieldEnabled / setGazeFollowEnabled 状态切换', () => {
    useSettingStore.getState().setParticleFieldEnabled(false);
    expect(useSettingStore.getState().particleFieldEnabled).toBe(false);
    useSettingStore.getState().setGazeFollowEnabled(true);
    expect(useSettingStore.getState().gazeFollowEnabled).toBe(true);
  });
});
