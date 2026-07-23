import { clipboard, dialog, ipcMain } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { expandUserPath } from '../utils/expandUserPath';
import { buildSessionExportZip, type ExportResult } from '../utils/sessionExport';

const TEXT_LIMIT = 800_000;

function saveFiltersForFileName(fileName: string): { name: string; extensions: string[] }[] {
  const ext = path.extname(fileName).replace(/^\./, '').toLowerCase();
  if (ext === 'docx') return [{ name: 'Word', extensions: ['docx'] }, { name: '所有文件', extensions: ['*'] }];
  if (ext === 'md' || ext === 'markdown') return [{ name: 'Markdown', extensions: ['md', 'markdown'] }, { name: '所有文件', extensions: ['*'] }];
  if (ext === 'txt') return [{ name: '纯文本', extensions: ['txt'] }, { name: '所有文件', extensions: ['*'] }];
  if (ext === 'xlsx') return [{ name: 'Excel', extensions: ['xlsx'] }, { name: '所有文件', extensions: ['*'] }];
  if (ext === 'pdf') return [{ name: 'PDF', extensions: ['pdf'] }, { name: '所有文件', extensions: ['*'] }];
  if (ext === 'png') return [{ name: 'PNG', extensions: ['png'] }, { name: '所有文件', extensions: ['*'] }];
  if (ext === 'jpg' || ext === 'jpeg') return [{ name: 'JPEG', extensions: ['jpg', 'jpeg'] }, { name: '所有文件', extensions: ['*'] }];
  return [{ name: '所有文件', extensions: ['*'] }];
}

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

ipcMain.handle(
  'save-local-file-copy',
  async (_e, arg: { sourcePath: string; defaultFileName: string }) => {
    const raw = String(arg?.sourcePath || '').trim();
    if (!raw) return { ok: false as const, error: '路径为空' as const };
    const src = path.resolve(expandUserPath(raw));
    try {
      await fs.stat(src);
    } catch {
      return { ok: false as const, error: '源文件不存在' as const };
    }
    const base = path.basename(String(arg.defaultFileName || '').trim()) || path.basename(src);
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: base,
      filters: saveFiltersForFileName(base),
    });
    if (canceled || !filePath) {
      return { ok: false as const, canceled: true as const };
    }
    const dst = path.resolve(filePath);
    await fs.copyFile(src, dst);
    return { ok: true as const, path: dst };
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

/**
 * 导出会话为 zip：用户选保存路径；我们读 chatStore 当前会话或传入 sid
 * 再去磁盘拉完整 session（不走 IPC → 走 chatStore 持久化文件 → 拿到原始 messages 树）
 */
ipcMain.handle(
  'session:export',
  async (
    _e,
    arg: {
      sessionId: string;
      defaultName?: string;
      /** 优先使用渲染进程内存快照，避免读磁盘未刷盘的旧会话 */
      session?: {
        id: string;
        title: string;
        createdAt: number;
        updatedAt: number;
        messages: unknown[];
        activeLeafId?: string | null;
      };
    }
  ): Promise<ExportResult | { ok: false; error: string; canceled?: boolean }> => {
    if (!arg?.sessionId) {
      return { ok: false, error: 'sessionId required' };
    }
    let session;
    if (arg.session && arg.session.id === arg.sessionId && Array.isArray(arg.session.messages)) {
      session = {
        id: arg.session.id,
        title: arg.session.title,
        createdAt: arg.session.createdAt,
        updatedAt: arg.session.updatedAt,
        messages: arg.session.messages as never,
        activeLeafId: arg.session.activeLeafId,
      };
    } else {
      const persistPath = path.join(
        (await import('electron')).app.getPath('userData'),
        'persist',
        'chat-storage.json'
      );
      try {
        const raw = await fs.readFile(persistPath, 'utf-8');
        const parsed = JSON.parse(raw) as {
          state?: {
            sessions?: Array<{
              id: string;
              title: string;
              createdAt: number;
              updatedAt: number;
              messages: unknown[];
              activeLeafId?: string | null;
            }>;
          };
        };
        const found = parsed?.state?.sessions?.find((s) => s.id === arg.sessionId);
        if (!found) return { ok: false, error: 'session not found' };
        session = {
          id: found.id,
          title: found.title,
          createdAt: found.createdAt,
          updatedAt: found.updatedAt,
          messages: found.messages as never,
          activeLeafId: found.activeLeafId,
        };
      } catch (e) {
        return { ok: false, error: `加载会话失败：${e instanceof Error ? e.message : String(e)}` };
      }
    }
    const safeName = (arg.defaultName || session.title || 'session').replace(/[\\/:*?"<>|]/g, '_');
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: `${safeName}.zip`,
      filters: [
        { name: 'Zip', extensions: ['zip'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (canceled || !filePath) {
      return { ok: false, error: 'canceled', canceled: true };
    }
    return buildSessionExportZip(session as never, filePath);
  }
);

console.log('✅ 导出/剪贴板 IPC 已注册');
