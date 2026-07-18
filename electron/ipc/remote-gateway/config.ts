import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { app } from 'electron';

import { readPersistParsedSync } from '../persist';

const CONFIG_FILE = 'remote-gateway.json';
const DEFAULT_PORT = 9742;

/** 与桌面 modelStore 默认项 id/name 对齐，桥接不可用或瞬时返回空时用 */
const REMOTE_MODEL_IDS_FALLBACK: Array<{ id: string; name: string }> = [
  { id: 'ollama-qwen3-vl-8b', name: 'Qwen3-VL 8B (本地)' },
  { id: 'ollama-qwen3-vl-2b', name: 'Qwen3-VL 2B (本地)' },
  { id: 'ollama-gemma4-26b', name: 'Gemma4 26B (本地)' },
];

function coerceRemoteModelSnap(
  models: unknown,
  active: unknown
): { models: Array<{ id: string; name: string }>; activeModelId: string | null } {
  const outModels: Array<{ id: string; name: string }> = [];
  if (Array.isArray(models)) {
    for (const m of models) {
      const rec = m as { id?: unknown; name?: unknown };
      const id = typeof rec.id === 'string' ? rec.id.trim() : rec.id != null ? String(rec.id).trim() : '';
      const name =
        typeof rec.name === 'string' ? rec.name.trim() : rec.name != null ? String(rec.name).trim() : '';
      if (id && name) outModels.push({ id, name });
      else if (id) outModels.push({ id, name: id });
    }
  }
  const activeModelId =
    typeof active === 'string' && active.trim()
      ? active.trim()
      : active == null
        ? null
        : String(active).trim() || null;
  return { models: outModels, activeModelId };
}

function deriveModelsFromPersistDisk(): {
  models: Array<{ id: string; name: string }>;
  activeModelId: string | null;
} | null {
  try {
    const raw = readPersistParsedSync('model-storage');
    if (!raw || typeof raw !== 'object') return null;
    const st = (raw as { state?: unknown }).state;
    if (!st || typeof st !== 'object') return null;
    const { models: mList, activeModelId } = coerceRemoteModelSnap(
      (st as { models?: unknown }).models,
      (st as { activeModelId?: unknown }).activeModelId
    );
    if (!mList.length) return null;
    let activeOk = activeModelId;
    if (!activeOk || !mList.some((m) => m.id === activeOk)) activeOk = mList[0].id;
    return { models: mList, activeModelId: activeOk ?? null };
  } catch {
    return null;
  }
}

export interface RemoteGatewayFileConfig {
  enabled: boolean;
  port: number;
  token: string;
}

export function randomToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export function configFilePath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE);
}

export function normalizeConfig(parsed: Record<string, unknown>): RemoteGatewayFileConfig {
  const enabled = Boolean(parsed.enabled);
  const portRaw = Number(parsed.port);
  const port =
    Number.isFinite(portRaw) && portRaw >= 1024 && portRaw <= 65535 ? Math.floor(portRaw) : DEFAULT_PORT;
  const tokenRaw = parsed.token != null ? String(parsed.token).trim() : '';
  const token = tokenRaw.length > 0 ? tokenRaw : randomToken();
  return { enabled, port, token };
}

export async function persistConfig(cfg: RemoteGatewayFileConfig): Promise<void> {
  await fs.mkdir(path.dirname(configFilePath()), { recursive: true });
  await fs.writeFile(configFilePath(), `${JSON.stringify(cfg, null, 2)}\n`, 'utf-8');
}

export async function loadOrCreateConfig(): Promise<RemoteGatewayFileConfig> {
  try {
    const txt = await fs.readFile(configFilePath(), 'utf-8');
    const parsed = JSON.parse(txt) as Record<string, unknown>;
    const n = normalizeConfig(parsed);
    if (!parsed.token || !String(parsed.token).trim()) {
      await persistConfig(n);
    }
    return n;
  } catch {
    const cfg: RemoteGatewayFileConfig = { enabled: false, port: DEFAULT_PORT, token: randomToken() };
    await persistConfig(cfg);
    return cfg;
  }
}

export function mergeRemoteGatewayPatch(
  current: RemoteGatewayFileConfig,
  patch: Partial<Pick<RemoteGatewayFileConfig, 'enabled' | 'port' | 'token'> & { regenerateToken?: boolean }>
): RemoteGatewayFileConfig {
  let next = { ...current };
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (patch.regenerateToken) next.token = randomToken();
  if (patch.port !== undefined && patch.port !== null) {
    const p = Number(patch.port);
    if (!Number.isFinite(p) || p < 1024 || p > 65535) {
      throw new Error('remote-gateway: invalid port (1024-65535)');
    }
    next.port = Math.floor(p);
  }
  if (patch.token !== undefined && patch.token !== null && !patch.regenerateToken) {
    const tok = String(patch.token).trim();
    if (!tok.length) throw new Error('remote-gateway: token empty');
    next.token = tok;
  }
  return next;
}

export { REMOTE_MODEL_IDS_FALLBACK, coerceRemoteModelSnap, deriveModelsFromPersistDisk };