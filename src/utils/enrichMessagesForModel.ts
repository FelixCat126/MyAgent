import type { Message } from '../types';
import type { Locale } from '../i18n/types';
import { t } from '../i18n/ui';

const DOC_EXTS = /\.(xlsx|xlsm|xls|docx|doc|md|markdown|txt|csv)$/i;

/** 与 electron/ipc/documents 中正文字数上限一致 */
const ATTACH_DOCUMENT_MAX_TEXT_CHARS = 600_000;

function isDocumentAttachment(f: { type: string; name: string }): boolean {
  if (f.type.startsWith('image/')) return false;
  if (f.type === 'application/pdf') return false;
  return (
    f.type.includes('sheet') ||
    f.type.includes('excel') ||
    f.type.includes('word') ||
    f.type.includes('markdown') ||
    f.type === 'text/plain' ||
    f.type === 'text/csv' ||
    DOC_EXTS.test(f.name)
  );
}

/**
 * 为发往模型的消息补全非图片附件的文本（Excel / Word / MD 等），不修改持久化在 store 里的内容。
 */
export async function enrichMessagesForModel(
  messages: Message[],
  _locale: Locale = 'zh'
): Promise<Message[]> {
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role !== 'user' || !m.files?.length) {
      out.push(m);
      continue;
    }
    const docFiles = m.files.filter(isDocumentAttachment);
    if (docFiles.length === 0) {
      out.push(m);
      continue;
    }
    const chunks: string[] = [m.content];
    for (const f of docFiles) {
      try {
        const r = await window.electron.extractDocumentText({ path: f.path, name: f.name });
        const approxBadge =
          _locale === 'en'
            ? `${Math.round(ATTACH_DOCUMENT_MAX_TEXT_CHARS / 1000)}k`
            : `${ATTACH_DOCUMENT_MAX_TEXT_CHARS / 10000}万`;
        if (r.ok && r.text) {
          chunks.push(`\n\n【附加文档: ${f.name}】\n${r.text}`);
          if (r.truncated) {
            chunks.push(`\n${t(_locale, 'attachment.docTruncNotice', { approx: approxBadge })}\n`);
          }
        } else if (!r.ok) {
          chunks.push(`\n\n【附加文档 ${f.name} 读取失败】${r.error || ''}`);
        }
      } catch (e) {
        chunks.push(`\n\n【附加文档 ${f.name} 读取异常】${e instanceof Error ? e.message : String(e)}`);
      }
    }
    out.push({ ...m, content: chunks.join('').trim() });
  }
  return out;
}
