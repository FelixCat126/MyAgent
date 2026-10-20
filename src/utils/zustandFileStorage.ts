import type { PersistStorage, StateStorage, StorageValue } from 'zustand/middleware';
import type { ChatPersistWrite, ElectronAPI } from '../types';
import { PERSIST_KEYS } from './persistKeys';

type PersistApi = Pick<
  ElectronAPI,
  | 'persistGet'
  | 'persistSet'
  | 'persistRemove'
  | 'persistClearAll'
  | 'persistGetSync'
  | 'persistSetSync'
> & Partial<Pick<ElectronAPI, 'persistChatWrite' | 'persistChatWriteSync'>>;

function hasFilePersist(e: unknown): e is PersistApi {
  return (
    typeof (e as PersistApi).persistGet === 'function' &&
    typeof (e as PersistApi).persistSet === 'function' &&
    typeof (e as PersistApi).persistRemove === 'function' &&
    typeof (e as PersistApi).persistClearAll === 'function'
  );
}

const DEBOUNCE_MS = 160;

let singleton: StateStorage | undefined;

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** 字符串或尚未序列化的 StorageValue；对象到写盘时才 stringify，流式高频 set 不再每拍序列化整份会话 */
const pendingValues = new Map<string, unknown>();
let pinnedPersistApi: PersistApi | null = null;
let persistSuspended = false;
const activeWrites = new Set<Promise<void>>();

function serializePending(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** 会话仓库按对话拆文件：记录上次成功落盘的会话对象引用，只序列化变化的会话 */
const writtenChatSessions = new Map<string, unknown>();

function chatSplit(api: PersistApi, name: string, value: unknown): { payload: ChatPersistWrite; refs: Map<string, unknown> } | null {
  if (name !== PERSIST_KEYS.chat || typeof api.persistChatWrite !== 'function') return null;
  if (!value || typeof value !== 'object') return null;
  const { state, ...meta } = value as { state?: unknown };
  if (!state || typeof state !== 'object' || !Array.isArray((state as { sessions?: unknown }).sessions)) return null;
  const { sessions, ...rest } = state as { sessions: unknown[] };
  const ids: string[] = [];
  const changed: Record<string, string> = {};
  const refs = new Map<string, unknown>();
  for (const session of sessions) {
    const id = (session as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !id || refs.has(id)) return null;
    ids.push(id);
    refs.set(id, session);
    if (writtenChatSessions.get(id) !== session) changed[id] = JSON.stringify(session);
  }
  const index = JSON.stringify({ ...meta, state: { ...rest, sessionIds: ids, sessionLayout: 'split-v1' } });
  return { payload: { index, ids, sessions: changed }, refs };
}

function commitChatRefs(refs: Map<string, unknown>): void {
  writtenChatSessions.clear();
  for (const [id, session] of refs) writtenChatSessions.set(id, session);
}

async function writeRepository(api: PersistApi, name: string, value: unknown): Promise<void> {
  const split = chatSplit(api, name, value);
  if (split) {
    await api.persistChatWrite!(split.payload);
    commitChatRefs(split.refs);
    return;
  }
  await api.persistSet(name, serializePending(value));
}

/** 卸载/恢复前的同步写；无同步通道时返回 false 由调用方改走异步 */
function writeRepositorySync(api: PersistApi, name: string, value: unknown): boolean {
  const split = typeof api.persistChatWriteSync === 'function' ? chatSplit(api, name, value) : null;
  if (split) {
    api.persistChatWriteSync!(split.payload);
    commitChatRefs(split.refs);
    return true;
  }
  if (typeof api.persistSetSync !== 'function') return false;
  api.persistSetSync(name, serializePending(value));
  return true;
}

async function persistNow(name: string, value: unknown): Promise<void> {
  if (persistSuspended || !pinnedPersistApi) return;
  const write = writeRepository(pinnedPersistApi, name, value); activeWrites.add(write);
  try { await write; if (pendingValues.get(name) === value) pendingValues.delete(name); }
  finally { activeWrites.delete(write); }
}

/**
 * 在页面卸载或切应用前尽最大努力落盘，减少 debounce 期间的数据丢失窗口
 */
export async function flushZustandFilePersist(): Promise<void> {
  const api = pinnedPersistApi;
  if (persistSuspended || !api) return;
  /** 不先等待进行中的异步写：beforeunload 里等不到主进程回包，同步写须立即发出；IPC 按发送顺序处理，旧写不会覆盖新值 */
  const inFlight = [...activeWrites];
  const pairs = [...pendingValues.entries()];
  for (const [name] of pairs) {
    const tmr = pendingTimers.get(name);
    if (tmr) clearTimeout(tmr);
    pendingTimers.delete(name);
  }
  await Promise.all(
    pairs.map(([name, value]) => {
      if (writeRepositorySync(api, name, value)) {
        if (pendingValues.get(name) === value) pendingValues.delete(name);
        return Promise.resolve();
      }
      return writeRepository(api, name, value).then(() => {
        if (pendingValues.get(name) === value) pendingValues.delete(name);
      });
    })
  );
  await Promise.all(inFlight);
}

/** Freeze writes before a restore, including beforeunload flushes from stale renderer stores. */
export async function suspendFilePersistForRestore(): Promise<void> {
  if (persistSuspended) throw new Error('数据恢复正在进行');
  persistSuspended = true;
  for (const timer of pendingTimers.values()) clearTimeout(timer);
  pendingTimers.clear();
  const pairs = [...pendingValues]; pendingValues.clear();
  try {
    await Promise.all([...activeWrites]);
    if (pinnedPersistApi) for (const [name,value] of pairs) {
      if (!writeRepositorySync(pinnedPersistApi, name, value)) await writeRepository(pinnedPersistApi, name, value);
    }
  } catch (error) { persistSuspended = false; for (const [name,value] of pairs) pendingValues.set(name,value); throw error; }
}
export function resumeFilePersistAfterRestoreFailure(): void { persistSuspended = false; }

/** 磁盘内容无法解析的仓库：本次运行不再写入，避免默认值覆盖原文件（留待排障/恢复） */
const unreadableRepositories = new Set<string>();

function scheduleFileWrite(name: string, value: unknown): void {
  if (persistSuspended || unreadableRepositories.has(name)) return;
  pendingValues.set(name, value);
  const prev = pendingTimers.get(name);
  if (prev) clearTimeout(prev);
  pendingTimers.set(
    name,
    setTimeout(() => {
      pendingTimers.delete(name);
      if (!pendingValues.has(name)) return;
      const v = pendingValues.get(name);
      void persistNow(name, v).catch(error => console.error('[Persist write]', error));
    }, DEBOUNCE_MS)
  );
}

function wrapElectronStorage(e: PersistApi): StateStorage {
  pinnedPersistApi = e;
  return {
    getItem: async (name) => {
      /** 先用同步读，降低 persist hydrate 未完成时误用空状态覆盖磁盘的风险 */
      try {
        if (typeof e.persistGetSync === 'function') {
          const syn = e.persistGetSync(name);
          if (syn != null && syn.length > 0) return syn;
        }
      } catch {
        /* ignore */
      }

      const fromFile = await e.persistGet(name);
      if (fromFile != null && fromFile.length > 0) {
        return fromFile;
      }
      try {
        const fromLs = localStorage.getItem(name);
        if (fromLs) {
          if (!persistSuspended) await e.persistSet(name, fromLs);
          localStorage.removeItem(name);
          return fromLs;
        }
      } catch {
        /* ignore */
      }
      return null;
    },
    setItem: async (name, value) => {
      scheduleFileWrite(name, value);
    },
    removeItem: async (name) => {
      if (persistSuspended) return;
      const tmr = pendingTimers.get(name);
      if (tmr) clearTimeout(tmr);
      pendingTimers.delete(name);
      pendingValues.delete(name);
      if (name === PERSIST_KEYS.chat) writtenChatSessions.clear();
      await e.persistRemove(name);
    },
  };
}

function getSingleton(): StateStorage {
  if (singleton) return singleton;
  if (typeof window !== 'undefined' && hasFilePersist((window as unknown as { electron?: unknown }).electron)) {
    const e = (window as unknown as { electron: PersistApi }).electron;
    singleton = wrapElectronStorage(e);
  } else {
    singleton = localStorage;
  }
  return singleton;
}

/**
 * 与主进程 `userData/persist` 下 JSON 文件同步，避免 `file://` 与 `http://localhost` 的 localStorage 隔离
 * 及开发态/安装包 userData 目录不一致导致「新装后像被清空」。
 */
function createDeferredJsonStorage(): PersistStorage<any> | undefined {
  let storage: StateStorage;
  try {
    storage = getSingleton();
  } catch {
    return undefined;
  }
  const parse = (name: string, text: string | null): StorageValue<any> | null => {
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      unreadableRepositories.add(name);
      pendingValues.delete(name);
      const timer = pendingTimers.get(name);
      if (timer) clearTimeout(timer);
      pendingTimers.delete(name);
      console.error(`[Persist] ${name} 磁盘内容无法解析，本次运行暂停写入以保留原文件`, error);
      throw error;
    }
  };
  return {
    getItem: (name) => {
      const text = storage.getItem(name) ?? null;
      return text instanceof Promise ? text.then((t) => parse(name, t)) : parse(name, text);
    },
    setItem: (name, value) => {
      if (unreadableRepositories.has(name)) return;
      if (pinnedPersistApi && storage === singleton) {
        scheduleFileWrite(name, value);
        return;
      }
      return storage.setItem(name, JSON.stringify(value));
    },
    removeItem: (name) => storage.removeItem(name),
  };
}

export const zustandPersistJson = createDeferredJsonStorage();
