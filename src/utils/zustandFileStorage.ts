import { createJSONStorage, type StateStorage } from 'zustand/middleware';
import type { ElectronAPI } from '../types';

type PersistApi = Pick<
  ElectronAPI,
  | 'persistGet'
  | 'persistSet'
  | 'persistRemove'
  | 'persistClearAll'
  | 'persistGetSync'
  | 'persistSetSync'
>;

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
const pendingValues = new Map<string, string>();
let pinnedPersistApi: PersistApi | null = null;
let persistSuspended = false;
const activeWrites = new Set<Promise<void>>();

async function persistNow(name: string, value: string): Promise<void> {
  if (persistSuspended || !pinnedPersistApi) return;
  const write = pinnedPersistApi.persistSet(name, value); activeWrites.add(write);
  try { await write; if (pendingValues.get(name) === value) pendingValues.delete(name); }
  finally { activeWrites.delete(write); }
}

/**
 * 在页面卸载或切应用前尽最大努力落盘，减少 debounce 期间的数据丢失窗口
 */
export async function flushZustandFilePersist(): Promise<void> {
  const api = pinnedPersistApi;
  if (persistSuspended || !api) return;
  await Promise.all([...activeWrites]);
  const pairs = [...pendingValues.entries()];
  for (const [name] of pairs) {
    const tmr = pendingTimers.get(name);
    if (tmr) clearTimeout(tmr);
    pendingTimers.delete(name);
  }
  const syncSave = api.persistSetSync;
  await Promise.all(
    pairs.map(([name, value]) => {
      if (typeof syncSave === 'function') {
        syncSave.call(api, name, value);
        if (pendingValues.get(name) === value) pendingValues.delete(name);
        return Promise.resolve();
      }
      return api.persistSet(name, value).then(() => {
        if (pendingValues.get(name) === value) pendingValues.delete(name);
      });
    })
  );
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
      if (typeof pinnedPersistApi.persistSetSync === 'function') pinnedPersistApi.persistSetSync(name,value);
      else await pinnedPersistApi.persistSet(name,value);
    }
  } catch (error) { persistSuspended = false; for (const [name,value] of pairs) pendingValues.set(name,value); throw error; }
}
export function resumeFilePersistAfterRestoreFailure(): void { persistSuspended = false; }

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
      if (persistSuspended) return;
      pendingValues.set(name, value);
      const prev = pendingTimers.get(name);
      if (prev) clearTimeout(prev);
      pendingTimers.set(
        name,
        setTimeout(() => {
          pendingTimers.delete(name);
          const v = pendingValues.get(name);
          if (v === undefined) return;
          void persistNow(name, v).catch(error => console.error('[Persist write]', error));
        }, DEBOUNCE_MS)
      );
    },
    removeItem: async (name) => {
      if (persistSuspended) return;
      const tmr = pendingTimers.get(name);
      if (tmr) clearTimeout(tmr);
      pendingTimers.delete(name);
      pendingValues.delete(name);
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
export const zustandPersistJson = createJSONStorage(getSingleton);
