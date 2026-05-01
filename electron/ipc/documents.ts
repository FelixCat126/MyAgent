import { dialog, ipcMain } from 'electron';
import fs from 'fs/promises';
import { extractTextFromPath } from '../utils/documentText';
import { markdownToXlsxBuffer, plainMarkdownToDocxBuffer } from '../utils/markdownExport';

/** 单次提取注入模型的正文上限；须与前端 enrichMessages 提示一致（约几十万字级别） */
const ATTACH_DOCUMENT_MAX_STATS_BYTES = 80 * 1024 * 1024;
/** 与中文字符量级同阶的 JS 字符串长度上限（非严格 Unicode 语义） */
const ATTACH_DOCUMENT_MAX_TEXT_CHARS = 600_000;

ipcMain.handle(
  'extract-document-text',
  async (_e, arg: { path: string; name?: string }) => {
    const p = String(arg?.path || '').trim();
    if (!p) return { ok: false as const, error: '路径为空' };
    try {
      const st = await fs.stat(p);
      if (st.size > ATTACH_DOCUMENT_MAX_STATS_BYTES) {
        return {
          ok: false as const,
          error:
            `文件过大（>${Math.round(ATTACH_DOCUMENT_MAX_STATS_BYTES / (1024 * 1024))}MB）；请压缩、拆分或使用较小附件。`,
        };
      }
      const { text: rawText, kind } = await extractTextFromPath(p, arg.name);
      let text = rawText;
      let truncated = false;
      if (text.length > ATTACH_DOCUMENT_MAX_TEXT_CHARS) {
        text = text.slice(0, ATTACH_DOCUMENT_MAX_TEXT_CHARS);
        truncated = true;
      }
      return { ok: true as const, text, kind, truncated };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false as const, error: msg };
    }
  }
);

ipcMain.handle(
  'save-assistant-export',
  async (
    _e,
    arg: {
      format: 'md' | 'xlsx' | 'docx';
      content: string;
      defaultBaseName: string;
    }
  ) => {
    const base = String(arg.defaultBaseName || 'export').replace(/[\\/:"*?<>|]/g, '_');
    const ext = arg.format === 'md' ? 'md' : arg.format === 'xlsx' ? 'xlsx' : 'docx';
    const filters =
      arg.format === 'md'
        ? [{ name: 'Markdown', extensions: ['md'] }]
        : arg.format === 'xlsx'
          ? [{ name: 'Excel', extensions: ['xlsx'] }]
          : [{ name: 'Word', extensions: ['docx'] }];

    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: `${base}.${ext}`,
      filters,
    });
    if (canceled || !filePath) return { ok: false as const };

    const content = String(arg.content ?? '');
    if (arg.format === 'md') {
      await fs.writeFile(filePath, content, 'utf8');
    } else if (arg.format === 'xlsx') {
      const buf = await markdownToXlsxBuffer(content);
      await fs.writeFile(filePath, buf);
    } else {
      const buf = await plainMarkdownToDocxBuffer(content);
      await fs.writeFile(filePath, buf);
    }
    return { ok: true as const, path: filePath };
  }
);

console.log('✅ 文档提取/导出 IPC 已注册');
