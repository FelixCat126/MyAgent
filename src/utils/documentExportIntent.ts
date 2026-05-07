import type { Message } from '../types';

export function documentExportFormatsFromHint(hint: Message['exportHint'] | undefined): Array<'md' | 'docx'> {
  const formats = hint?.formats?.length ? hint.formats : ['docx'];
  return [...new Set(formats)].filter((f): f is 'md' | 'docx' => f === 'md' || f === 'docx');
}

export function inferDocumentExportHint(userText: string): Message['exportHint'] | undefined {
  const t = String(userText || '').trim();
  if (!t) return undefined;
  const asksDownload = /下载|导出|保存|生成.{0,8}(?:文件|文档|电子版)|可下载|download|export|save/i.test(t);
  const asksDocument = /文档|电子版|文章|著作|书稿|手稿|资料|报告|讲义|word|docx|markdown|\bmd\b|document|ebook|manuscript|article|report/i.test(t);
  if (!asksDownload || !asksDocument) return undefined;
  const wantsMd = /markdown|\bmd\b/i.test(t);
  const wantsDocx = /word|docx|文档|电子版|document|ebook|manuscript|article|report/i.test(t);
  const formats: Array<'md' | 'docx'> = wantsMd && !wantsDocx ? ['md'] : wantsDocx && !wantsMd ? ['docx'] : ['md', 'docx'];
  return { document: true, formats };
}

function cleanBaseName(input: string, fallback: string): string {
  return input
    .replace(/[\\/:"*?<>|\r\n\t]/g, '_')
    .replace(/^[#\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || fallback;
}

export function documentArtifactBaseNameFromContent(content: string, fallback = 'document'): string {
  const t = String(content || '').trim();
  const heading =
    t.match(/^#\s+(.{1,80})$/m)?.[1] ||
    t.match(/^##\s+(.{1,80})$/m)?.[1] ||
    t.match(/^标题\s*[:：]\s*(.{1,80})$/m)?.[1];
  if (heading) return cleanBaseName(heading, fallback);
  const firstTextLine = t
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !/^[-*_`>|]/.test(line));
  return cleanBaseName(firstTextLine || '', fallback);
}

export function documentArtifactBaseName(userText: string, fallback = 'document'): string {
  const t = String(userText || '').trim();
  const named =
    t.match(/(?:《([^》]{1,60})》)/)?.[1] ||
    t.match(/(?:标题|文件名|文档名)\s*[:：]\s*([^\n]{1,60})/)?.[1];
  return cleanBaseName(named || '', fallback);
}

export function shouldBypassModelForFullTextDownload(userText: string, hasSourceAttachment = false): boolean {
  if (hasSourceAttachment) return false;
  const t = String(userText || '').trim();
  if (!inferDocumentExportHint(t)) return false;
  const wantsSourceText =
    /全文|全本|完整原文|原文全文|整本|全集|原著|原文|节选|摘录|选段|选取|第\s*[一二三四五六七八九十百\d]+\s*回|前\s*[一二三四五六七八九十百\d]+\s*回|full\s*text|excerpt|extract|complete\s+(?:book|text|novel|work)/i.test(t);
  const existingWork =
    /(?:三国演义|红楼梦|西游记|水浒传|金瓶梅|论语|道德经|史记|资治通鉴|小说|名著|著作|书籍|古籍|典籍|原著|book|novel|work|text)/i.test(t);
  const derivativeDocument =
    /(?:读书报告|读后感|摘要|总结|梗概|人物关系|人物分析|赏析|解读|研究|论文|提纲|大纲|讲义|课件|改写|翻译|白话|分析报告|summary|analysis|report|outline)/i.test(t);
  const asksCreation = /原创|写一篇|撰写|创作|生成一篇|帮我写|draft|write\s+(?:an?|the)/i.test(t);
  return existingWork && wantsSourceText && !derivativeDocument && !asksCreation;
}
