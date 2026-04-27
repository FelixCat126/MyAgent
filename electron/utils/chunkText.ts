/**
 * 将长文本切为可嵌入的短块（按段落 + 定长，带重叠以便保留边界语义）
 */
const DEFAULT_MAX = 900;
const DEFAULT_OVERLAP = 100;

export function chunkText(raw: string, maxLen = DEFAULT_MAX, overlap = DEFAULT_OVERLAP): string[] {
  const t = raw.replace(/\r\n/g, '\n').trim();
  if (!t) return [];
  if (t.length <= maxLen) return [t];

  const parts: string[] = [];
  const paras = t.split(/\n{2,}/);
  let buf = '';

  const flush = () => {
    const s = buf.trim();
    if (s) parts.push(s);
    buf = '';
  };

  for (const p of paras) {
    if (!p.trim()) continue;
    if (buf.length + p.length + 2 <= maxLen) {
      buf = buf ? `${buf}\n\n${p}` : p;
      continue;
    }
    if (buf) {
      flush();
      if (p.length <= maxLen) {
        buf = p;
        continue;
      }
    }
    for (let i = 0; i < p.length; i += maxLen - overlap) {
      const window = p.slice(i, i + maxLen);
      if (window.trim()) parts.push(window.trim());
    }
  }
  if (buf.trim()) flush();
  return parts;
}
