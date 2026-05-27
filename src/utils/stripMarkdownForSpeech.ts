/** 播报前清理 Markdown / 代码，保留可读正文 */
export function stripMarkdownForSpeech(raw: string): string {
  let s = raw;
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/`[^`]+`/g, ' ');
  s = s.replace(/!\[[^\]]*]\([^)]+\)/g, ' ');
  s = s.replace(/\[([^\]]+)]\([^)]+\)/g, '$1');
  s = s.replace(/^#{1,6}\s+/gm, '');
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');
  s = s.replace(/(\*|_)(.*?)\1/g, '$2');
  s = s.replace(/~~(.*?)~~/g, '$1');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/\|/g, ' ');
  s = s.replace(/[-*_]{3,}/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** 从缓冲区取出已完整的句子，剩余留待后续 delta */
export function takeCompleteSentences(buf: string): { sentences: string[]; remainder: string } {
  const sentences: string[] = [];
  let rest = buf;
  for (;;) {
    const m = rest.match(
      /^[\s\S]*?(?:[。！？!?；;]|\n+|(?<=[a-zA-Z0-9])\.\s+(?=[A-Z0-9「"'])|[.!?]\s+)/
    );
    if (!m) break;
    const seg = m[0].trim();
    if (seg.length >= 2) sentences.push(seg);
    rest = rest.slice(m[0].length);
  }
  return { sentences, remainder: rest };
}
