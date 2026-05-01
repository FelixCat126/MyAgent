/**
 * 同时支持旧版 XML 标签与 JSON 工具声明（MCP/Agent 习惯）
 * JSON 示例：{"myagent_tool":"launch_app","name":"访达"} 或 {"tool":"generate_image","prompt":"..."}
 */
export function extractLaunchAppNames(text: string): { name: string; raw: string }[] {
  const out: { name: string; raw: string }[] = [];
  const reXml = /<LaunchApp\s+name="([^"]+)"\s*\/>/g;
  for (const m of text.matchAll(reXml)) {
    out.push({ name: m[1], raw: m[0] });
  }
  for (const m of text.matchAll(/\{"myagent_tool"\s*:\s*"launch_app"[^}]*"name"\s*:\s*"([^"\\]+)"[^}]*\}/gi)) {
    const raw = m[0];
    if (out.some((o) => o.raw === raw)) continue;
    out.push({ name: m[1], raw });
  }
  for (const m of text.matchAll(
    /\{"tool"\s*:\s*"(?:launchApp|launch_app)"[^}]*"name"\s*:\s*"([^"\\]+)"[^}]*\}/gi
  )) {
    const raw = m[0];
    if (out.some((o) => o.raw === raw)) continue;
    out.push({ name: m[1], raw });
  }
  return out;
}

/** 给定位置为 `{` 时，求与之平衡的最外层闭合 `}` 下标；-1 表示未闭合（流式半截 JSON） */
export function endOfBalancedBraceObject(text: string, openBraceIndex: number): number {
  if (openBraceIndex < 0 || openBraceIndex >= text.length || text[openBraceIndex] !== '{') {
    return -1;
  }
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = openBraceIndex; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === '\\') {
        esc = true;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function collectGenerateImageJsonSpans(text: string): { start: number; end: number; raw: string }[] {
  type Span = { start: number; end: number; raw: string };
  const spans: Span[] = [];
  const seen = new Set<string>();

  const tryAddFromMarkedKeyPos = (keyCharPos: number) => {
    for (
      let s = text.lastIndexOf('{', keyCharPos);
      s !== -1;
      s = text.lastIndexOf('{', s - 1)
    ) {
      const endClose = endOfBalancedBraceObject(text, s);
      if (endClose < keyCharPos) continue;
      const raw = text.slice(s, endClose + 1);
      if (!parseGenerateImageFields(raw)) continue;
      const key = `${s}:${endClose}`;
      if (seen.has(key)) continue;
      seen.add(key);
      spans.push({ start: s, end: endClose, raw });
      return;
    }
  };

  const reMt = /"myagent_tool"\s*:\s*"generate_image"/gi;
  let m: RegExpExecArray | null;
  while ((m = reMt.exec(text)) !== null) {
    tryAddFromMarkedKeyPos(m.index);
  }
  const reTg = /[{\[,]\s*"tool"\s*:\s*"generate_image"/gi;
  while ((m = reTg.exec(text)) !== null) {
    const g = text.indexOf('"generate_image"', m.index);
    if (g < 0) continue;
    tryAddFromMarkedKeyPos(g);
  }

  spans.sort((a, b) => a.start - b.start);
  return spans;
}

function parseGenerateImageFields(
  raw: string
): { prompt: string; width?: number; height?: number } | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const tool = obj.myagent_tool ?? obj.tool;
  if (tool !== 'generate_image') return null;
  const prompt = obj.prompt;
  if (typeof prompt !== 'string') return null;
  const width = obj.width;
  const height = obj.height;
  const num = (v: unknown): number | undefined => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
    return undefined;
  };
  return {
    prompt,
    width: num(width),
    height: num(height),
  };
}

/** 去掉模型复读的「到外站粘贴 prompt / 授权失败转第三方绘」话术，不进用户可见气泡正文。 */
function shouldStripThirdPartyImageFallbackLine(line: string): boolean {
  const t = line.trim();
  if (!t || /^\*\[/.test(t)) return false;

  const mentionsExternal =
    /文心一格|通义\s*万相|通义万相|百度\s*一格|阿里\s*万相/.test(t) ||
    /第三方\s*(?:AI)?绘(?:图)?/.test(t) ||
    /\b(?:other|third[\s-]*party)[\s-]*(?:image|drawing|art)\s*platform/i.test(t);

  const copyOrRedirectFlow =
    /复制(?:上述)?\s*[Pp]rompt|[Pp]rompt\s*(?:复制|到|至)|paste\s+(?:your\s+)?(?:the\s+)?prompt/i.test(t) ||
    /(?:你可|您可以|你可以|可以|建议您).{0,16}(?:复制|粘贴).{0,24}(?:文心|通义|third|third-party|平台)/.test(t);

  const authExcuseStory =
    /密钥|授权|鉴权|\b401\b/i.test(t) && /异常|失败|无效|被拒|暂不|暂时|temporary/i.test(t);

  return (
    (mentionsExternal || /AI绘图平台|AI绘画平台/i.test(t)) &&
    (copyOrRedirectFlow || authExcuseStory || /(?:快去|不妨试试|也可以使用).{0,20}(?:文心|通义|third|平台上)/i.test(t))
  );
}

export function stripThirdPartyImageFallbackHints(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((line) => !shouldStripThirdPartyImageFallbackLine(line));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/**
 * 模型常有「英文 Prompt / 英文Prompt」+ 围栏，与客户端插入的可复制块重复。
 * 仅当围栏内正文与某一 knownPrompt **全文一致**，且紧靠围栏上方的最后一行看起来像「英文 Prompt」且不含「可复制」时才删，
 * 避免误删客户端的「英文 Prompt（可复制）」「本次生图使用的英文描述（可复制到其他平台）」之类标题。
 */
export function stripRedundantAssistantImagePromptBlocks(text: string, knownPrompts: string[]): string {
  let t = text.replace(/\r\n/g, '\n').trimEnd();
  const norms = [...new Set(knownPrompts.map((p) => p.replace(/\r\n/g, '\n').trimEnd()))].filter(
    (x) => x.length >= 8
  );
  if (!norms.length) return t.replace(/\r\n/g, '\n').trimEnd();

  const normBody = (b: string) => b.trim();

  const isRedundantEnglishPromptHeading = (line: string) => {
    const plain = line.trim().replace(/^#+\s*/, '').replace(/\*/g, '');
    if (!plain) return false;
    if (/可复制到其他平台|[（(]可复制[）)\]]|可复制）/.test(plain)) return false;
    return /英文\s*[Pp]rompt|English\s+[Pp]rompt/i.test(plain);
  };

  for (let round = 0; round < 50; round++) {
    let replaced = false;
    let cursor = 0;

    outer: while (cursor < t.length) {
      const openIdx = t.indexOf('```', cursor);
      if (openIdx < 0) break outer;

      const lineStart = openIdx === 0 ? 0 : t.lastIndexOf('\n', openIdx - 1) + 1;
      /** 围栏从行首开始（行前仅有空白），避免误伤内联 `code` */
      if (openIdx !== lineStart && !/^[\t ]*$/.test(t.slice(lineStart, openIdx))) {
        cursor = openIdx + 3;
        continue;
      }

      const nlAfterOpen = t.indexOf('\n', openIdx + 3);
      if (nlAfterOpen < 0) break outer;

      const innerStart = nlAfterOpen + 1;
      const closeNl = t.indexOf('\n```', innerStart);
      if (closeNl < 0) break outer;

      let spanEnd = closeNl + '\n```'.length;
      if (spanEnd < t.length && t[spanEnd] === '\n') spanEnd += 1;

      const innerNorm = normBody(t.slice(innerStart, closeNl));

      cursor = innerStart;

      const matchedNorm = norms.find((n) => normBody(n) === innerNorm);
      if (!matchedNorm || !innerNorm.length) {
        cursor = openIdx + 3;
        continue;
      }

      /** 围栏上一段文本：去掉尾部空白后的最后一行是否为冗余「英文 Prompt」标题 */
      let te = lineStart;
      while (te > 0 && /\s/.test(t[te - 1])) te--;
      if (te <= 0) {
        cursor = openIdx + 3;
        continue;
      }

      const sub = t.slice(0, te);
      const ln = sub.lastIndexOf('\n');
      const lastLine = ln >= 0 ? sub.slice(ln + 1) : sub;
      const headerStartIdx = ln >= 0 ? ln + 1 : 0;

      if (!isRedundantEnglishPromptHeading(lastLine)) {
        cursor = openIdx + 3;
        continue;
      }

      /** 删掉标题行前的一个换行，避免多出空栈 */
      let spanStart = headerStartIdx;
      if (headerStartIdx > 0 && t[headerStartIdx - 1] === '\n') spanStart = headerStartIdx - 1;

      t = t.slice(0, spanStart) + t.slice(spanEnd);
      replaced = true;
      cursor = 0;
    }

    if (!replaced) break;
  }

  return t.replace(/\n{3,}/g, '\n\n').trimEnd();
}

/** 去掉 Markdown 围栏内及裸漏的生图 JSON；流式未闭合的一段也会从首个 `{ "myagent_tool": "generate_image"` 起截掉尾段 */
export function stripGenerateImageArtifactsForDisplay(text: string): string {
  const looksLikeGenerateImagePayload = (inner: string) =>
    /"myagent_tool"\s*:\s*"generate_image"|"tool"\s*:\s*"generate_image"/i.test(inner.trim());

  let out = text.replace(/```(?:json)?\s*\n?([\s\S]*?)```/gi, (full, inner) => {
    if (looksLikeGenerateImagePayload(inner)) return '';
    return full;
  });

  const spans = collectGenerateImageJsonSpans(out);
  for (let i = spans.length - 1; i >= 0; i--) {
    const { start, end } = spans[i];
    out = out.slice(0, start) + out.slice(end + 1);
  }

  let lastPartial = -1;
  const partialRes = [/{\s*"myagent_tool"\s*:\s*"generate_image"/gi, /{\s*"tool"\s*:\s*"generate_image"/gi];
  for (const re of partialRes) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(out)) !== null) {
      const st = m.index;
      const en = endOfBalancedBraceObject(out, st);
      if (en < 0) lastPartial = Math.max(lastPartial, st);
    }
  }
  if (lastPartial >= 0) {
    out = out.slice(0, lastPartial);
  }

  out = stripThirdPartyImageFallbackHints(out);
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trimEnd();
}

/** @deprecated 使用 stripGenerateImageArtifactsForDisplay */
export function stripGenerateImageToolPresentation(text: string): string {
  return stripGenerateImageArtifactsForDisplay(text);
}

export function extractGenerateImageCalls(
  text: string
): { prompt: string; width?: number; height?: number; raw: string }[] {
  const out: { prompt: string; width?: number; height?: number; raw: string }[] = [];
  const reXml =
    /<GenerateImage\s+prompt="([^"]+)"(?:\s+width="(\d+)"(?:\s+height="(\d+)"?)?)?\s*\/>/g;
  for (const m of text.matchAll(reXml)) {
    out.push({
      prompt: m[1],
      width: m[2] ? parseInt(m[2], 10) : undefined,
      height: m[3] ? parseInt(m[3], 10) : undefined,
      raw: m[0],
    });
  }
  const spans = collectGenerateImageJsonSpans(text);
  for (const { raw } of spans) {
    if (out.some((o) => o.raw === raw)) continue;
    const parsed = parseGenerateImageFields(raw);
    if (!parsed) continue;
    out.push({ prompt: parsed.prompt, width: parsed.width, height: parsed.height, raw });
  }
  return out;
}
