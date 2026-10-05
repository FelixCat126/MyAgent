import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ModelConfig } from '../types';
import { PERSIST_KEYS } from '../utils/persistKeys';
import { zustandPersistJson } from '../utils/zustandFileStorage';

export type ServiceConnection = {
  id: string; name: string; provider: ModelConfig['provider']; apiUrl: string;
  apiKey: string; chatApiMode: ModelConfig['chatApiMode']; updatedAt: number;
  /** Automatically organized services retain the model's explicit local/remote policy. */
  isLocal?: boolean;
  autoOrganized?: boolean;
  effectiveChatApiMode?: 'openai' | 'anthropic';
};
export type ConnectionOrganizationSummary = {
  services: number; models: number; organizedServices: number; organizedModels: number;
  skippedModels: number; status: 'ready' | 'pending' | 'failed';
};
type ConnectionState = {
  connections: ServiceConnection[];
  organizationSummary: ConnectionOrganizationSummary;
  saveConnection: (value: Omit<ServiceConnection, 'updatedAt'>) => void;
  removeConnection: (id: string) => void;
};
export function validateConnection(value: Pick<ServiceConnection, 'name' | 'apiUrl'>): string | null {
  if (!value.name.trim()) return '连接名称不能为空 / Connection name is required';
  try {
    const url = new URL(value.apiUrl.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
  } catch { return '请填写有效的 HTTP(S) 服务地址 / Enter a valid HTTP(S) service URL'; }
  return null;
}
export const useConnectionStore = create<ConnectionState>()(persist((set) => ({
  connections: [],
  organizationSummary: {services:0,models:0,organizedServices:0,organizedModels:0,skippedModels:0,status:'pending'},
  saveConnection: (value) => {
    const error = validateConnection(value);
    if (error) throw new Error(error);
    const item = { ...value, name: value.name.trim(), apiUrl: value.apiUrl.trim(), apiKey: value.apiKey.trim(), updatedAt: Date.now() };
    set((state) => ({ connections: state.connections.some(c => c.id === item.id)
      ? state.connections.map(c => c.id === item.id ? item : c) : [...state.connections, item] }));
  },
  removeConnection: (id) => set(state => ({ connections: state.connections.filter(c => c.id !== id) })),
}), { name: PERSIST_KEYS.connection, version: 1, storage: zustandPersistJson, partialize: state => ({connections:state.connections}) }));

export function resolveModelConnection(model: ModelConfig): ModelConfig {
  return resolveModelConnectionFrom(model, useConnectionStore.getState().connections);
}
export function resolveModelConnectionFrom(model: ModelConfig, connections: readonly ServiceConnection[]): ModelConfig {
  const connection = model.connectionId ? connections.find(c => c.id === model.connectionId) : undefined;
  let resolved = model;
  if (connection) {
    const isLocal = connection.isLocal ?? (connection.provider === 'ollama' || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(connection.apiUrl));
    const apiKey = connection.apiKey === '' && model.apiKey === undefined ? undefined : connection.apiKey;
    resolved = { ...model, provider: connection.provider, apiUrl: connection.apiUrl, apiKey, chatApiMode: connection.chatApiMode ?? model.chatApiMode, isLocal };
  }
  const video = model.videoGeneratorConfig;
  if (video?.connectionId) {
    const own = connections.find(c => c.id === video.connectionId);
    return own ? {...resolved, videoGeneratorConfig:{...video,apiKey:own.apiKey}} : resolved;
  }
  return video && !video.apiKey?.trim() && connection?.apiKey ? {...resolved,videoGeneratorConfig:{...video,apiKey:connection.apiKey}} : resolved;
}

/** 诊断与配置绑定，修改连接或模型后旧诊断不再用于自动路由。 */
export function modelCapabilitySignature(model: ModelConfig): string {
  const m = resolveModelConnection(model);
  let hash = 2166136261;
  const value = JSON.stringify([m.provider, m.apiUrl, m.modelName, m.chatApiMode, m.apiKey]);
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16);
}
export function hasCurrentCapability(model: ModelConfig, kind: 'chat' | 'stream' | 'history' | 'tools' | 'vision'): boolean | undefined {
  if (model.capabilities?.signature !== modelCapabilitySignature(model)) return undefined;
  const status = model.capabilities[kind];
  return status ? status === 'verified' : undefined;
}
