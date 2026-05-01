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

async function persistNow(name: string, value: string): Promise<void> {
  pinnedPersistApi?.persistSet(name, value);
}

/**
 * 在页面卸载或切应用前尽最大努力落盘，减少 debounce 期间的数据丢失窗口
 */
export async function flushZustandFilePersist(): Promise<void> {
  if (!pinnedPersistApi) return;
  const pairs = [...pendingValues.entries()];
  for (const [name] of pairs) {
    const tmr = pendingTimers.get(name);
    if (tmr) clearTimeout(tmr);
    pendingTimers.delete(name);
  }
  const syncSave = pinnedPersistApi.persistSetSync;
  await Promise.all(
    pairs.map(([name, value]) => {
      if (typeof syncSave === 'function') {
        syncSave.call(pinnedPersistApi!, name, value);
        pendingValues.delete(name);
        return Promise.resolve();
      }
      return pinnedPersistApi!.persistSet(name, value).then(() => {
        pendingValues.delete(name);
      });
    })
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
          await e.persistSet(name, fromLs);
          localStorage.removeItem(name);
          return fromLs;
        }
      } catch {
        /* ignore */
      }
      return null;
    },
    setItem: async (name, value) => {
      pendingValues.set(name, value);
      const prev = pendingTimers.get(name);
      if (prev) clearTimeout(prev);
      pendingTimers.set(
        name,
        setTimeout(() => {
          pendingTimers.delete(name);
          const v = pendingValues.get(name);
          if (v === undefined) return;
          void persistNow(name, v);
        }, DEBOUNCE_MS)
      );
    },
    removeItem: async (name) => {
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
