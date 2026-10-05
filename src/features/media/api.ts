import type { FileInfo } from '../../types/message';
export type MediaVersion = { id: string; path: string; createdAt: number; prompt?: string; modelId?: string; model?: string; parentPaths: string[]; masked: boolean; width?: number; height?: number; missing?: boolean };
export interface MediaWorkbenchAPI {
  chooseMediaReference(): Promise<{ ok: true; file: FileInfo } | { ok: false; canceled?: boolean; error?: string }>;
  readMediaVersions(arg: { path: string }): Promise<{ ok: true; versions: MediaVersion[] } | { ok: false; error: string }>;
}
