import os from 'os';
import path from 'path';

/** 将 ~/xxx 或 ~ 展开为当前用户主目录下的绝对路径（与访达拖入路径行为一致） */
export function expandUserPath(input: string): string {
  const s = String(input || '').trim();
  if (!s) return s;
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) {
    return path.join(os.homedir(), s.slice(2));
  }
  return s;
}
