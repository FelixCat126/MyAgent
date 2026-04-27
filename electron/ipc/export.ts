import { clipboard, dialog, ipcMain } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { expandUserPath } from '../utils/expandUserPath';

const TEXT_LIMIT = 800_000;

ipcMain.handle(
  'save-text-file',
  async (
    _e,
    arg: { defaultName: string; content: string; filters?: { name: string; extensions: string[] }[] }
  ) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: arg.defaultName,
      filters:
        arg.filters ||
        [
          { name: 'Markdown', extensions: ['md'] },
          { name: 'HTML', extensions: ['html', 'htm'] },
          { name: 'JSON', extensions: ['json'] },
          { name: '纯文本', extensions: ['txt'] },
        ],
    });
    if (canceled || !filePath) {
      return { ok: false as const };
    }
    await fs.writeFile(filePath, arg.content, 'utf8');
    return { ok: true as const, path: filePath };
  }
);

ipcMain.handle('import-text-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: '文本/Markdown', extensions: ['txt', 'md', 'markdown'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (canceled || !filePaths[0]) {
    return { ok: false as const };
  }
  const p = filePaths[0];
  const text = await fs.readFile(p, 'utf8');
  return { ok: true as const, text, name: path.basename(p) };
});

/** 将工作区相对路径或绝对路径读为 UTF-8 文本（用于本地知识） */
ipcMain.handle('read-text-file-absolute', async (_e, filePath: string) => {
  const p = String(filePath || '').trim();
  if (!p) {
    return { ok: false as const, error: '路径为空' };
  }
  const resolved = path.resolve(p);
  try {
    const st = await fs.stat(resolved);
    if (st.size > TEXT_LIMIT) {
      return { ok: false as const, error: `文件过大（>${TEXT_LIMIT} 字节）` };
    }
    const text = await fs.readFile(resolved, 'utf8');
    return { ok: true as const, path: resolved, text };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false as const, error: msg };
  }
});

ipcMain.handle('get-clipboard-text', async () => {
  return clipboard.readText();
});

ipcMain.handle('set-clipboard-text', async (_e, t: string) => {
  clipboard.writeText(String(t));
  return true;
});

/** 尝试从工作区根目录读取轻量知识文件（存在则注入为 system，顺序：MYAGENT_KNOWLEDGE.md → knowledge.md → README.md） */
ipcMain.handle(
  'read-workspace-hint',
  async (_e, arg: { root: string; maxChars: number }) => {
    const rawRoot = String(arg?.root || '').trim();
    if (!rawRoot) return { ok: false as const };
    const root = path.resolve(expandUserPath(rawRoot));
    const max = Math.min(200_000, Math.max(500, arg?.maxChars ?? 12_000));
    for (const name of ['MYAGENT_KNOWLEDGE.md', 'knowledge.md', 'README.md']) {
      const p = path.join(root, name);
      try {
        const st = await fs.stat(p);
        if (st.size > TEXT_LIMIT) continue;
        const text = (await fs.readFile(p, 'utf8')).slice(0, max);
        return { ok: true as const, fileName: name, text };
      } catch {
        /* 尝试下一个 */
      }
    }
    return { ok: false as const };
  }
);

console.log('✅ 导出/剪贴板 IPC 已注册');
