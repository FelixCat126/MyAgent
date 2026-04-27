import { createJSONStorage, type StateStorage } from 'zustand/middleware';
import type { ElectronAPI } from '../types';

type PersistApi = Pick<
  ElectronAPI,
  'persistGet' | 'persistSet' | 'persistRemove' | 'persistClearAll'
>;

function hasFilePersist(e: unknown): e is PersistApi {
  return (
    typeof (e as PersistApi).persistGet === 'function' &&
    typeof (e as PersistApi).persistSet === 'function' &&
    typeof (e as PersistApi).persistRemove === 'function' &&
    typeof (e as PersistApi).persistClearAll === 'function'
  );
}

let singleton: StateStorage | undefined;

function getSingleton(): StateStorage {
  if (singleton) return singleton;
  if (typeof window !== 'undefined' && hasFilePersist((window as unknown as { electron?: unknown }).electron)) {
    const e = (window as unknown as { electron: PersistApi }).electron;
    singleton = {
      getItem: async (name) => {
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
        await e.persistSet(name, value);
      },
      removeItem: async (name) => {
        await e.persistRemove(name);
      },
    };
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
