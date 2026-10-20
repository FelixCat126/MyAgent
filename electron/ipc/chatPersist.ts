import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

/**
 * 会话仓库按对话拆分落盘：
 * - `chat-storage.json` 只存索引（`sessionIds` 顺序 + 当前选中等小字段）；
 * - 每个对话一个 `chat-session.<id>.json`。
 * 读取时拼回旧的整份结构交给渲染端，zustand 的 merge / migrate 不感知拆分。
 * 旧版整份格式（state.sessions 内嵌）照常可读，首次写入时迁移并留一份 pre-split 副本。
 */
export const CHAT_PERSIST_NAME = 'chat-storage';
export const CHAT_SESSION_PREFIX = 'chat-session.';
export const CHAT_PRE_SPLIT_NAME = 'chat-storage.pre-split';
const SPLIT_LAYOUT = 'split-v1';

export interface ChatSplitWrite {
  /** 索引 JSON：`{ state: { ...除 sessions 外的字段 }, version }` */
  index: string;
  /** 全部会话 id（顺序即列表顺序） */
  ids: string[];
  /** 自上次成功写入后变化的会话：id → 会话 JSON */
  sessions: Record<string, string>;
}

type JsonObject = Record<string, unknown>;

const lastWritten = new Map<string, string>();

export function chatSessionFileName(id: string): string {
  const safe = /^[a-z0-9_-][a-z0-9._-]{0,119}$/i.test(id) ? id : `h${createHash('sha256').update(id).digest('hex').slice(0, 40)}`;
  return `${CHAT_SESSION_PREFIX}${safe}`;
}

function jsonPath(dir: string, name: string): string {
  return path.join(dir, `${name}.json`);
}

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.pending`;
  try {
    fs.writeFileSync(temporary, text, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sessionId(value: unknown): string | null {
  return isObject(value) && typeof value.id === 'string' && value.id ? value.id : null;
}

function listSessionFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((n) => n.startsWith(CHAT_SESSION_PREFIX) && n.endsWith('.json'));
  } catch {
    return [];
  }
}

/** 首次从整份格式迁出前留一份原样副本，降级或排障时可手动改回。 */
function keepPreSplitCopy(dir: string): void {
  const indexFile = jsonPath(dir, CHAT_PERSIST_NAME);
  const copyFile = jsonPath(dir, CHAT_PRE_SPLIT_NAME);
  if (fs.existsSync(copyFile)) return;
  const raw = readOrNull(indexFile);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed) || !isObject(parsed.state) || !Array.isArray(parsed.state.sessions) || Array.isArray(parsed.state.sessionIds)) return;
  } catch {
    return;
  }
  writeAtomic(copyFile, raw);
}

/** 顺序：会话文件 → 索引 → 清理已删除对话的文件；任一步中断都不会让索引指向缺失内容之外的状态。 */
export function writeChatSplitSync(dir: string, payload: ChatSplitWrite): void {
  const ids = payload.ids.filter((id) => typeof id === 'string' && id);
  keepPreSplitCopy(dir);
  for (const [id, text] of Object.entries(payload.sessions)) {
    if (typeof text !== 'string') continue;
    if (lastWritten.get(id) === text) continue;
    writeAtomic(jsonPath(dir, chatSessionFileName(id)), text);
    lastWritten.set(id, text);
  }
  writeAtomic(jsonPath(dir, CHAT_PERSIST_NAME), payload.index);
  const keep = new Set(ids.map((id) => `${chatSessionFileName(id)}.json`));
  /** 只清理本进程读到或写过、且已被移除的会话；渲染端未能加载的会话文件绝不删除 */
  const known = new Set([...lastWritten.keys()].map((id) => `${chatSessionFileName(id)}.json`));
  for (const file of listSessionFiles(dir)) {
    if (keep.has(file) || !known.has(file)) continue;
    try { fs.unlinkSync(path.join(dir, file)); } catch { /* already gone */ }
  }
  for (const id of [...lastWritten.keys()]) if (!ids.includes(id)) lastWritten.delete(id);
}

/** 兼容旧调用方（测试脚本、旧渲染端）写入整份结构：在主进程拆开后落盘。 */
export function writeChatFullTextSync(dir: string, text: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    writeAtomic(jsonPath(dir, CHAT_PERSIST_NAME), text);
    return;
  }
  if (!isObject(parsed) || !isObject(parsed.state) || !Array.isArray(parsed.state.sessions)) {
    writeAtomic(jsonPath(dir, CHAT_PERSIST_NAME), text);
    return;
  }
  const { sessions, ...rest } = parsed.state;
  const ids: string[] = [];
  const changed: Record<string, string> = {};
  const unnamed: unknown[] = [];
  for (const session of sessions as unknown[]) {
    const id = sessionId(session);
    if (!id) { unnamed.push(session); continue; }
    ids.push(id);
    changed[id] = JSON.stringify(session);
  }
  const state: JsonObject = { ...rest, sessionIds: ids, sessionLayout: SPLIT_LAYOUT };
  if (unnamed.length) state.sessions = unnamed;
  writeChatSplitSync(dir, { index: JSON.stringify({ ...parsed, state }), ids, sessions: changed });
}

/** 拼回 `{ state: { sessions, ... }, version }`；旧格式或无法识别的内容原样返回。 */
export function readChatAssembledSync(dir: string): string | null {
  const indexFile = jsonPath(dir, CHAT_PERSIST_NAME);
  const raw = readOrNull(indexFile);
  if (raw == null) return rebuildFromSessionFiles(dir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      fs.renameSync(indexFile, jsonPath(dir, `chat-corrupt.${Date.now()}.index`));
    } catch { /* leave as is */ }
    console.error('[chat-persist] 会话索引损坏，已隔离并按会话文件重建');
    return rebuildFromSessionFiles(dir) ?? raw;
  }
  if (!isObject(parsed) || !isObject(parsed.state) || !Array.isArray(parsed.state.sessionIds)) return raw;
  const { sessionIds, sessionLayout: _layout, sessions: embedded, ...rest } = parsed.state;
  const legacy = new Map<string, unknown>();
  const unnamed: unknown[] = [];
  // 合并模式恢复旧版备份时，索引里可能同时带有内嵌会话。
  if (Array.isArray(embedded)) {
    for (const session of embedded) {
      const id = sessionId(session);
      if (id) legacy.set(id, session); else unnamed.push(session);
    }
  }
  const sessions: unknown[] = [];
  const seen = new Set<string>();
  for (const id of sessionIds as unknown[]) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    const file = jsonPath(dir, chatSessionFileName(id));
    const text = readOrNull(file);
    if (text != null) {
      try {
        const session = JSON.parse(text) as unknown;
        if (sessionId(session) === id) {
          sessions.push(session);
          lastWritten.set(id, text);
          legacy.delete(id);
          continue;
        }
      } catch { /* fall through to quarantine */ }
      try {
        fs.renameSync(file, jsonPath(dir, `chat-corrupt.${Date.now()}.${chatSessionFileName(id).slice(CHAT_SESSION_PREFIX.length)}`));
      } catch { /* leave as is */ }
      console.error('[chat-persist] 会话文件损坏，已隔离:', id);
    }
    if (legacy.has(id)) {
      sessions.push(legacy.get(id));
      legacy.delete(id);
    }
  }
  sessions.push(...legacy.values(), ...unnamed);
  return JSON.stringify({ ...parsed, state: { ...rest, sessions } });
}

/** 索引缺失或损坏时，按会话文件拼回（最近更新在前）；没有会话文件则返回 null */
function rebuildFromSessionFiles(dir: string): string | null {
  const sessions: JsonObject[] = [];
  for (const file of listSessionFiles(dir)) {
    const text = readOrNull(path.join(dir, file));
    if (text == null) continue;
    try {
      const session = JSON.parse(text) as unknown;
      const id = sessionId(session);
      if (!id || `${chatSessionFileName(id)}.json` !== file) continue;
      sessions.push(session as JsonObject);
      lastWritten.set(id, text);
    } catch { /* 单个坏文件保持原样，不影响其余会话 */ }
  }
  if (sessions.length === 0) return null;
  const updatedAt = (s: JsonObject) => (typeof s.updatedAt === 'number' ? s.updatedAt : 0);
  sessions.sort((a, b) => updatedAt(b) - updatedAt(a));
  return JSON.stringify({ state: { sessions, currentSessionId: sessionId(sessions[0]) } });
}

export function removeChatStorageSync(dir: string): void {
  for (const file of [`${CHAT_PERSIST_NAME}.json`, ...listSessionFiles(dir)]) {
    try { fs.unlinkSync(path.join(dir, file)); } catch { /* already gone */ }
  }
  lastWritten.clear();
}

export function isChatSplitWrite(value: unknown): value is ChatSplitWrite {
  return isObject(value)
    && typeof value.index === 'string'
    && Array.isArray(value.ids)
    && value.ids.length <= 100_000
    && isObject(value.sessions);
}
