import type { Message } from "../types";
import { DOCUMENT_FORMATS, type DocumentFormat } from "../types/document";

export function documentExportFormatsFromHint(
  hint: Message["exportHint"],
): DocumentFormat[] {
  return [
    ...new Set(
      hint?.formats?.length ? hint.formats : (["docx"] as DocumentFormat[]),
    ),
  ].filter((f) => DOCUMENT_FORMATS.includes(f));
}

export function declinesDocumentExport(text: string): boolean {
  return /(?:不要|不用|无需|别|不必).{0,8}(?:生成|导出|下载|保存|文件|文档)|(?:只|仅).{0,5}(?:解释|介绍|说明|讨论)|(?:如何|怎么|怎样).{0,12}(?:下载|导出|生成|保存|制作|写)|how\s+to|\b(?:do not|don't)\s+(?:create|generate|export|save)/i.test(
    text,
  );
}

export function inferDocumentExportHint(
  userText: string,
): Message["exportHint"] | undefined {
  const t = String(userText || "").trim();
  if (!t || declinesDocumentExport(t)) return undefined;
  const patterns: Array<[DocumentFormat, RegExp]> = [
    ["docx", /\b(?:word|docx)\b/i],
    ["pdf", /\bpdf\b/i],
    ["xlsx", /\b(?:excel|xlsx)\b|电子表格/i],
    ["md", /markdown|\bmd\b/i],
    ["txt", /\btxt\b|纯文本/i],
    ["csv", /\bcsv\b/i],
  ];
  const target =
    t.match(
      /(?:转(?:换)?(?:成|为)?|改成|另存为|导出(?:成|为)|保存为|整理成|汇总成|总结成|做成|生成|制作|输出|撰写)\s*(.+)$/i,
    )?.[1] ?? t;
  const positiveTarget = target.replace(
    /(?:不要|不用|无需|不需要|别)\s*(?:word|docx|pdf|excel|xlsx|markdown|md|txt|csv)(?:格式)?/gi,
    "",
  );
  const formats = patterns
    .filter(([, re]) => re.test(positiveTarget))
    .map(([f]) => f);
  const action =
    /下载|导出|保存|生成|制作|整理成|做成|转成|转换|改成|给我|提供|输出|另存|撰写|编写|写一|做一|想要|需要|download|export|save|create|generate|convert/i.test(
      t,
    );
  if (!action) return undefined;
  if (formats.length) return { document: true, formats };
  if (/pptx?|powerpoint|演示文稿|幻灯片|\b(?:zip|rtf|odt|epub)\b/i.test(t))
    return undefined;
  if (
    /(?:下载|导出|保存|生成|制作|做成).{0,30}(?:文件|文档|电子版|报告|讲义)|(?:文档|报告|书稿|电子版|资料|文章).{0,20}(?:下载|导出|保存)/i.test(
      t,
    )
  )
    return { document: true, formats: ["docx"] };
  return undefined;
}

export function unsupportedDocumentRequest(text: string): boolean {
  return (
    !declinesDocumentExport(text) &&
    /生成|导出|保存|制作|做成|转成|改成|给我|download|export|create|convert/i.test(
      text,
    ) &&
    /pptx?|powerpoint|演示文稿|幻灯片|\b(?:zip|rtf|odt|epub)\b/i.test(text)
  );
}

/** Only reuse the preceding body for an unambiguous format-only follow-up. */
export function previousDocumentBody(
  text: string,
  history: Message[],
): string | undefined {
  if (
    !inferDocumentExportHint(text) ||
    !/刚才|上面|上一|这份|这个|这段|上述|previous|above/i.test(text) ||
    /修改|改写|补充|增加|添加|删除|保留|翻译|重写|润色|总结|扩写|精简|revise|translate/i.test(
      text,
    )
  )
    return undefined;
  const previous = [...history].reverse().find((m) => m.role === "assistant");
  if (!previous) return undefined;
  if (previous.exportHint?.sourceContent)
    return previous.exportHint.sourceContent;
  return previous.files?.length
    ? undefined
    : previous.content?.trim() || undefined;
}

/**
 * 根据**助手回复内容**反推导出格式——用户不必明说"下载"，AI 回复里如果有结构化内容
 * （文档、表格、清单）就自动出导出按钮，按内容智能选格式：
 * - 含 h1/h2 标题 + 长度 > 400 → docx + pdf + md（文档型）
 * - 含 markdown 表格 → 加 xlsx（结构化数据型）
 * - 含表格且用户问"对比/列表/表格" → xlsx 优先
 */
export function inferReplyExportHint(
  replyContent: string,
  userText = "",
): Message["exportHint"] | undefined {
  const c = String(replyContent || "").trim();
  if (!c || declinesDocumentExport(userText)) return undefined;

  const looksDocument = /(^|\n)#{1,6}\s+/.test(c) && c.length > 400;
  const hasTable = /\|.+\|.+\|/.test(c);
  const userAskedTable = /表格|列表|对比|table|list/i.test(userText);

  if (!looksDocument && !hasTable && !userAskedTable) return undefined;

  const formats: Array<"md" | "docx" | "xlsx" | "pdf"> = ["md"];
  if (looksDocument) {
    formats.push("docx");
    formats.push("pdf");
  }
  if (hasTable || userAskedTable) formats.push("xlsx");

  return { document: true, formats };
}

function cleanBaseName(input: string, fallback: string): string {
  return (
    input
      .replace(
        /\s*[（(]\s*(?:可用于|适合|用于)?\s*(?:导出|保存|下载)(?:至|为|成)?\s*(?:Excel|Word|PDF|CSV|Markdown|TXT|XLSX|DOCX)(?:\s*文件)?\s*[）)]/gi,
        "",
      )
      .replace(/[\\/:"*?<>|\r\n\t]/g, "_")
      .replace(/^[#\s]+/, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60) || fallback
  );
}

export function documentArtifactBaseNameFromContent(
  content: string,
  fallback = "document",
): string {
  const t = String(content || "").trim();
  const heading =
    t.match(/^#\s+(.{1,80})$/m)?.[1] ||
    t.match(/^##\s+(.{1,80})$/m)?.[1] ||
    t.match(/^标题\s*[:：]\s*(.{1,80})$/m)?.[1];
  if (heading) return cleanBaseName(heading, fallback);
  const firstTextLine = t
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !/^[-*_`>|]/.test(line));
  return cleanBaseName(firstTextLine || "", fallback);
}

export function documentArtifactBaseName(
  userText: string,
  fallback = "document",
): string {
  const t = String(userText || "").trim();
  const named =
    t.match(/(?:《([^》]{1,60})》)/)?.[1] ||
    t.match(/(?:标题|文件名|文档名)\s*[:：]\s*([^\n]{1,60})/)?.[1];
  return cleanBaseName(named || "", fallback);
}

export function shouldBypassModelForFullTextDownload(
  userText: string,
  hasSourceAttachment = false,
): boolean {
  if (hasSourceAttachment) return false;
  const t = String(userText || "").trim();
  if (!inferDocumentExportHint(t)) return false;
  const wantsSourceText =
    /全文|全本|完整原文|原文全文|整本|全集|原著|原文|节选|摘录|选段|选取|第\s*[一二三四五六七八九十百\d]+\s*回|前\s*[一二三四五六七八九十百\d]+\s*回|full\s*text|excerpt|extract|complete\s+(?:book|text|novel|work)/i.test(
      t,
    );
  const existingWork =
    /(?:三国演义|红楼梦|西游记|水浒传|金瓶梅|论语|道德经|史记|资治通鉴|小说|名著|著作|书籍|古籍|典籍|原著|book|novel|work|text)/i.test(
      t,
    );
  const derivativeDocument =
    /(?:读书报告|读后感|摘要|总结|梗概|人物关系|人物分析|赏析|解读|研究|论文|提纲|大纲|讲义|课件|改写|翻译|白话|分析报告|summary|analysis|report|outline)/i.test(
      t,
    );
  const asksCreation =
    /原创|写一篇|撰写|创作|生成一篇|帮我写|draft|write\s+(?:an?|the)/i.test(t);
  return (
    existingWork && wantsSourceText && !derivativeDocument && !asksCreation
  );
}
