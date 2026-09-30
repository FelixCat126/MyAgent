import { app, dialog, ipcMain } from "electron";
import fs from "fs/promises";
import path from "path";
import { extractTextFromPath } from "../utils/documentText";
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

/** 单次提取注入模型的正文上限；须与前端 enrichMessages 提示一致（约几十万字级别） */
const ATTACH_DOCUMENT_MAX_STATS_BYTES = 80 * 1024 * 1024;
/** 与中文字符量级同阶的 JS 字符串长度上限（非严格 Unicode 语义） */
const ATTACH_DOCUMENT_MAX_TEXT_CHARS = 600_000;

function safeBaseName(input: string): string {
  const s = String(input || "document")
    .replace(/[\\/:"*?<>|\r\n\t]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return s || "document";
}

ipcMain.handle(
  "extract-document-text",
  async (_e, arg: { path: string; name?: string }) => {
    const p = String(arg?.path || "").trim();
    if (!p) return { ok: false as const, error: "路径为空" };
    try {
      const st = await fs.stat(p);
      if (st.size > ATTACH_DOCUMENT_MAX_STATS_BYTES) {
        return {
          ok: false as const,
          error: `文件过大（>${Math.round(ATTACH_DOCUMENT_MAX_STATS_BYTES / (1024 * 1024))}MB）；请压缩、拆分或使用较小附件。`,
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
    const target = filePath.toLowerCase().endsWith("." + arg.format)
      ? filePath
      : filePath + "." + arg.format;
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
