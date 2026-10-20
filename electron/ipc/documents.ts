import { app, dialog, ipcMain } from "electron";
import fs from "fs/promises";
import path from "path";
import { extractTextFromPath, isSensitiveReadPath } from "../utils/documentText";
import {
  markdownToXlsxBuffer,
  plainMarkdownToDocxBuffer,
  markdownToHtml,
  markdownToCsv,
  markdownToPlainText,
} from "../utils/markdownExport";
import {
  isDocumentFormat,
  type DocumentFormat,
} from "../../src/types/document";
import { randomUUID } from "node:crypto";
import { registerDocumentWorkbenchIPC } from "../document-workbench/ipc";

/** 单次提取注入模型的正文上限；须与前端 enrichMessages 提示一致（约几十万字级别） */
const ATTACH_DOCUMENT_MAX_STATS_BYTES = 80 * 1024 * 1024;
/** 与中文字符量级同阶的 JS 字符串长度上限（非严格 Unicode 语义） */
const ATTACH_DOCUMENT_MAX_TEXT_CHARS = 600_000;

export function safeBaseName(input: string): string {
  const s = Array.from(
    String(input || "document")
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
      .replace(/[\\/:"*?<>|\u0000-\u001F]/g, "_")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, 80)
    .join("")
    .replace(/[. ]+$/, "");
  if (!s) return "document";
  return /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s) ? `${s}_` : s;
}

type ExtractResult = Awaited<ReturnType<typeof extractTextFromPath>>;
/** 每轮发送都会对历史附件重新提取；按 路径+mtime+大小 缓存，避免扫描件反复 OCR */
const extractCache = new Map<string, Promise<ExtractResult>>();
const EXTRACT_CACHE_LIMIT = 32;

function extractCached(p: string, name: string | undefined, st: { mtimeMs: number; size: number }) {
  const key = `${path.resolve(p)}\n${name ?? ""}\n${st.mtimeMs}\n${st.size}`;
  const hit = extractCache.get(key);
  if (hit) {
    extractCache.delete(key);
    extractCache.set(key, hit);
    return hit;
  }
  const task = extractTextFromPath(p, name);
  extractCache.set(key, task);
  task.catch(() => extractCache.delete(key));
  while (extractCache.size > EXTRACT_CACHE_LIMIT)
    extractCache.delete(extractCache.keys().next().value!);
  return task;
}

ipcMain.handle(
  "extract-document-text",
  async (_e, arg: { path: string; name?: string }) => {
    const p = String(arg?.path || "").trim();
    if (!p) return { ok: false as const, error: "路径为空" };
    if (isSensitiveReadPath(p))
      return { ok: false as const, error: "该路径属于系统或凭据目录，已拒绝读取" };
    try {
      const st = await fs.stat(p);
      if (st.size > ATTACH_DOCUMENT_MAX_STATS_BYTES) {
        return {
          ok: false as const,
          error: `文件过大（>${Math.round(ATTACH_DOCUMENT_MAX_STATS_BYTES / (1024 * 1024))}MB）；请压缩、拆分或使用较小附件。`,
        };
      }
      const { text: rawText, kind, pages, truncated: extractionTruncated } = await extractCached(p, arg.name, st);
      let text = rawText;
      let truncated = Boolean(extractionTruncated);
      if (text.length > ATTACH_DOCUMENT_MAX_TEXT_CHARS) {
        text = text.slice(0, ATTACH_DOCUMENT_MAX_TEXT_CHARS);
        truncated = true;
      }
      return { ok: true as const, text, kind, pages, truncated };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false as const, error: msg };
    }
  },
);

const mime: Record<DocumentFormat, string> = {
  md: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
type ExportRequest = {
  format: DocumentFormat;
  content: string;
  defaultBaseName: string;
};
function validate(arg: ExportRequest): void {
  if (!arg || !isDocumentFormat(arg.format))
    throw new Error(
      "不支持的文件格式，请选择 Word、PDF、Excel、Markdown、TXT 或 CSV。",
    );
  if (typeof arg.content !== "string" || !arg.content.trim())
    throw new Error("正文为空，无法生成文件。");
  if (Buffer.byteLength(arg.content, "utf8") > 12 * 1024 * 1024)
    throw new Error("正文过大，请分成多个文件生成。");
}
export async function documentBuffer(arg: ExportRequest): Promise<Buffer> {
  validate(arg);
  switch (arg.format) {
    case "md":
      return Buffer.from(arg.content, "utf8");
    case "txt":
      return Buffer.from(markdownToPlainText(arg.content), "utf8");
    case "csv":
      return Buffer.from(markdownToCsv(arg.content), "utf8");
    case "docx":
      return plainMarkdownToDocxBuffer(arg.content);
    case "xlsx":
      return markdownToXlsxBuffer(arg.content);
    case "pdf": {
      const { BrowserWindow } = await import("electron");
      const win = new BrowserWindow({
        show: false,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          javascript: false,
        },
      });
      const temp = path.join(
        app.getPath("temp"),
        `myagent-pdf-${randomUUID()}.html`,
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await fs.writeFile(temp, markdownToHtml(arg.content), { mode: 0o600 });
        return await Promise.race([
          (async () => {
            await win.loadFile(temp);
            return win.webContents.printToPDF({
              pageSize: "A4",
              printBackground: true,
              preferCSSPageSize: true,
              displayHeaderFooter: true,
              headerTemplate: "<span></span>",
              footerTemplate:
                '<div style="font-size:9px;color:#64748b;text-align:center;width:100%"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
            });
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("PDF 排版超时，请缩短内容后重试。")),
              45000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
        if (!win.isDestroyed()) win.destroy();
        await fs.unlink(temp).catch(() => {});
      }
    }
  }
}
async function writeDocument(
  arg: ExportRequest,
  target: string,
): Promise<void> {
  const buffer = await documentBuffer(arg);
  if (!buffer.length) throw new Error("生成结果为空。");
  const temporary = target + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(temporary, buffer, { mode: 0o600 });
    /** 临时文件 0600 仅用于写入过程；落盘后沿用已有文件权限，新文件用常规 0644 */
    const mode = await fs
      .stat(target)
      .then((s) => s.mode & 0o777)
      .catch(() => 0o644);
    await fs.chmod(temporary, mode).catch(() => {});
    await fs.rename(temporary, target);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}
ipcMain.handle("save-assistant-export", async (_e, arg: ExportRequest) => {
  try {
    validate(arg);
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: `${safeBaseName(arg.defaultBaseName)}.${arg.format}`,
      filters: [{ name: arg.format.toUpperCase(), extensions: [arg.format] }],
    });
    if (canceled || !filePath) return { ok: false as const };
    const appended = !filePath.toLowerCase().endsWith("." + arg.format);
    const target = appended ? filePath + "." + arg.format : filePath;
    /** 自动补扩展名后的目标未经过保存对话框的覆盖确认 */
    if (appended && (await fs.stat(target).then(() => true, () => false))) {
      const { response } = await dialog.showMessageBox({
        type: "warning",
        buttons: ["覆盖", "取消"],
        defaultId: 1,
        cancelId: 1,
        message: `“${path.basename(target)}”已存在，是否覆盖？`,
      });
      if (response !== 0) return { ok: false as const };
    }
    await writeDocument(arg, target);
    return { ok: true as const, path: target };
  } catch (e) {
    return {
      ok: false as const,
      error: e instanceof Error ? e.message : String(e),
    };
  }
});
ipcMain.handle("create-document-artifact", async (_e, arg: ExportRequest) => {
  try {
    validate(arg);
    const dir = path.join(
      app.getPath("documents"),
      "MyAgent",
      "GeneratedDocuments",
    );
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(
      dir,
      `${safeBaseName(arg.defaultBaseName)}-${randomUUID().slice(0, 8)}.${arg.format}`,
    );
    await writeDocument(arg, filePath);
    const st = await fs.stat(filePath);
    return {
      ok: true as const,
      file: {
        name: path.basename(filePath),
        path: filePath,
        type: mime[arg.format],
        size: st.size,
      },
    };
  } catch (e) {
    return {
      ok: false as const,
      error: e instanceof Error ? e.message : String(e),
    };
  }
});

registerDocumentWorkbenchIPC(documentBuffer);
