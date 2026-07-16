/**
 * 持久化存储 key 集中管理。
 *
 * 所有 zustand persist + 部分 localStorage flag 的存储 key 都应从这里取，
 * 避免 SettingsPanel「清空所有数据」时硬编码遗漏新加的 store。
 */

export const PERSIST_KEYS = {
  chat: 'chat-storage',
  setting: 'setting-storage',
  workspace: 'workspace-storage',
  webSearch: 'web-search-storage',
  model: 'model-storage',
  knowledge: 'knowledge-storage',
  onboarding: 'myagent-onboarding-dismissed',
} as const;

export type PersistKey = (typeof PERSIST_KEYS)[keyof typeof PERSIST_KEYS];
