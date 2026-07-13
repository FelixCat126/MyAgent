import { endOfBalancedBraceObject } from '../utils/toolCalls';

export type AgentLocalToolName =
  | 'local_search'
  | 'local_list'
  | 'local_read'
  | 'local_export'
  | 'web_open'
  | 'web_read'
  | 'web_eval'
  | 'web_close';

export type AgentToolCall =
  | { tool: 'local_search'; query: string; mode?: 'semantic' | 'filename' | 'image'; limit?: number; raw: string }
  | { tool: 'local_list'; subpath?: string; maxDepth?: number; extensions?: string[]; raw: string }
  | { tool: 'local_read'; path: string; raw: string }
  | {
      tool: 'local_export';
      format: 'md' | 'docx' | 'xlsx';
      content: string;
      name: string;
      raw: string;
    }
  | { tool: 'web_open'; url: string; raw: string }
  | { tool: 'web_read'; maxChars?: number; selector?: string; raw: string }
  | { tool: 'web_eval'; js: string; raw: string }
  | { tool: 'web_close'; raw: string };

const LOCAL_TOOL_NAMES = new Set<string>([
  'local_search',
  'local_list',
  'local_read',
  'local_export',
  'web_open',
  'web_read',
  'web_eval',
  'web_close',
]);

function collectLocalToolJsonSpans(text: string): { start: number; end: number; raw: string }[] {
  const spans: { start: number; end: number; raw: string }[] = [];
  const seen = new Set<string>();
  const re = /"myagent_tool"\s*:\s*"(local_search|local_list|local_read|local_export|web_open|web_read|web_eval|web_close)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const keyPos = m.index;
    for (let s = text.lastIndexOf('{', keyPos); s !== -1; s = text.lastIndexOf('{', s - 1)) {
      const endClose = endOfBalancedBraceObject(text, s);
      if (endClose < keyPos) continue;
      const raw = text.slice(s, endClose + 1);
      const key = `${s}:${endClose}`;
      if (seen.has(key)) break;
      seen.add(key);
      spans.push({ start: s, end: endClose, raw });
      break;
    }
  }
  spans.sort((a, b) => a.start - b.start);
  return spans;
}

function normalizeToolUrl(url: string): string {
  const t = String(url || '').trim();
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
    u.hash = '';
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return t.toLowerCase();
  }
}

/** 用于跨轮次去重：相同签名视为同一操作，不重复执行 */
export function toolCallSignature(call: AgentToolCall): string {
  switch (call.tool) {
    case 'local_search':
      return `local_search:${call.mode ?? 'semantic'}:${call.query}:${call.limit ?? ''}`;
    case 'local_list':
      return `local_list:${call.subpath ?? ''}:${call.maxDepth ?? ''}:${(call.extensions ?? []).join(',')}`;
    case 'local_read':
      return `local_read:${call.path.trim()}`;
    case 'local_export': {
      const c = call.content;
      return `local_export:${call.format}:${call.name}:${c.length}:${c.slice(0, 80)}:${c.slice(-80)}`;
    }
    case 'web_open':
      return `web_open:${normalizeToolUrl(call.url)}`;
    case 'web_read':
      return `web_read:${call.selector ?? ''}:${call.maxChars ?? 4000}`;
    case 'web_eval': {
      const jsNorm = call.js.replace(/\s+/g, ' ').trim();
      // 提图类脚本归一为同一签名，避免微调 JS 绕过去重
      if (/data-imgurl|imgitem|first.?image|naturalWidth|data-objurl/i.test(jsNorm)) {
        return 'web_eval:baidu-first-image-extract';
      }
      return `web_eval:${jsNorm}`;
    }
    case 'web_close':
      return 'web_close';
    default:
      return 'unknown';
  }
}

function parseLocalToolCall(raw: string): AgentToolCall | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const tool = String(obj.myagent_tool ?? obj.tool ?? '');
  if (!LOCAL_TOOL_NAMES.has(tool)) return null;

  if (tool === 'local_search') {
    const query = typeof obj.query === 'string' ? obj.query.trim() : '';
    if (!query) return null;
    const modeRaw = String(obj.mode ?? 'semantic');
    const mode =
      modeRaw === 'filename' ? 'filename' : modeRaw === 'image' ? 'image' : 'semantic';
    const limit =
      typeof obj.limit === 'number' && Number.isFinite(obj.limit)
        ? Math.floor(obj.limit)
        : undefined;
    return { tool: 'local_search', query, mode, limit, raw };
  }

  if (tool === 'local_list') {
    const subpath = typeof obj.subpath === 'string' ? obj.subpath : undefined;
    const maxDepth =
      typeof obj.maxDepth === 'number' && Number.isFinite(obj.maxDepth)
        ? Math.floor(obj.maxDepth)
        : undefined;
    const extensions = Array.isArray(obj.extensions)
      ? obj.extensions.filter((x): x is string => typeof x === 'string')
      : undefined;
    return { tool: 'local_list', subpath, maxDepth, extensions, raw };
  }

  if (tool === 'local_read') {
    const p = typeof obj.path === 'string' ? obj.path.trim() : '';
    if (!p) return null;
    return { tool: 'local_read', path: p, raw };
  }

  if (tool === 'local_export') {
    const formatRaw = String(obj.format ?? 'md');
    const format =
      formatRaw === 'docx' ? 'docx' : formatRaw === 'xlsx' ? 'xlsx' : 'md';
    const content = typeof obj.content === 'string' ? obj.content : '';
    const name = typeof obj.name === 'string' ? obj.name.trim() : 'export';
    if (!content.trim()) return null;
    return { tool: 'local_export', format, content, name, raw };
  }

  if (tool === 'web_open') {
    const url = typeof obj.url === 'string' ? obj.url.trim() : '';
    if (!url) return null;
    return { tool: 'web_open', url, raw };
  }

  if (tool === 'web_read') {
    const maxChars =
      typeof obj.maxChars === 'number' && Number.isFinite(obj.maxChars)
        ? Math.floor(obj.maxChars)
        : undefined;
    const selector = typeof obj.selector === 'string' ? obj.selector : undefined;
    return { tool: 'web_read', maxChars, selector, raw };
  }

  if (tool === 'web_eval') {
    const js = typeof obj.js === 'string' ? obj.js : '';
    if (!js.trim()) return null;
    return { tool: 'web_eval', js, raw };
  }

  if (tool === 'web_close') {
    return { tool: 'web_close', raw };
  }

  return null;
}

export function extractAgentLocalToolCalls(text: string): AgentToolCall[] {
  const out: AgentToolCall[] = [];
  const spans = collectLocalToolJsonSpans(text);
  for (const { raw } of spans) {
    const parsed = parseLocalToolCall(raw);
    if (parsed && !out.some((o) => o.raw === raw)) out.push(parsed);
  }
  return out;
}

/** 去掉助手可见正文中的本机/浏览器工具 JSON */
export function stripAgentLocalToolArtifacts(text: string): string {
  let out = text.replace(/```(?:json)?\s*\n?([\s\S]*?)```/gi, (full, inner) => {
    if (/\"myagent_tool\"\s*:\s*\"(local_|web_)/.test(inner)) return '';
    return full;
  });

  const spans = collectLocalToolJsonSpans(out);
  for (let i = spans.length - 1; i >= 0; i--) {
    const { start, end } = spans[i];
    out = out.slice(0, start) + out.slice(end + 1);
  }

  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trimEnd();
}

export function hasAgentLocalToolCalls(text: string): boolean {
  return extractAgentLocalToolCalls(text).length > 0;
}
