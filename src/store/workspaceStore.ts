import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { zustandPersistJson } from '../utils/zustandFileStorage';

/**
 * 本地工作区/知识根路径（主进程可读取其下小文本文件，注入为上下文说明）
 */
interface WorkspaceStore {
  rootPath: string;
  /** 附加时最多读取的字符数 */
  maxChars: number;
  setRootPath: (p: string) => void;
  setMaxChars: (n: number) => void;
}

export const useWorkspaceStore = create<WorkspaceStore>()(
  persist(
    (set) => ({
      rootPath: '',
      maxChars: 12_000,
      setRootPath: (p: string) => set({ rootPath: p }),
      setMaxChars: (n: number) => set({ maxChars: Math.min(200_000, Math.max(500, n)) }),
    }),
    { name: 'workspace-storage', version: 1, storage: zustandPersistJson }
  )
);
