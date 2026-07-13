/**
 * 对话接口协议：OpenAI Chat Completions vs Anthropic Messages。
 * 多数厂商走 OpenAI；需要独立 thinking 块（如 MiniMax）或官方 Claude 走 Anthropic。
 */

export type ChatApiModePreference = 'auto' | 'openai' | 'anthropic';
export type ResolvedChatApiMode = 'openai' | 'anthropic';

export function looksLikeMiniMaxChat(apiUrl: string, modelName: string): boolean {
  const u = String(apiUrl ?? '').toLowerCase();
  const m = String(modelName ?? '').toLowerCase().replace(/\s+/g, '');
  return (
    /\bapi\.minimaxi?\.(io|com|chat)\b/.test(u) ||
    u.includes('minimax') ||
    m.includes('minimax') ||
    /^minimax-m[23]/.test(m)
  );
}

/** 解析最终走哪条对话协议（显式选择优先于自动推断） */
export function resolveChatApiMode(input: {
  chatApiMode?: ChatApiModePreference | null;
  provider?: string;
  apiUrl?: string;
  modelName?: string;
}): ResolvedChatApiMode {
  const pref = input.chatApiMode ?? 'auto';
  if (pref === 'openai' || pref === 'anthropic') return pref;

  if (input.provider === 'claude') return 'anthropic';

  const url = String(input.apiUrl ?? '');
  if (/\/anthropic(\/|$)/i.test(url) || /\banthropic\.com\b/i.test(url)) {
    return 'anthropic';
  }
  if (looksLikeMiniMaxChat(url, input.modelName ?? '')) return 'anthropic';
  return 'openai';
}

/**
 * 将用户填写的 API 地址规范为 Anthropic Messages URL。
 * - MiniMax：`…/anthropic/v1/messages`
 * - 官方 Claude / 多数兼容：`…/v1/messages`
 * - 已是 `/messages` 则原样规范化
 */
export function resolveAnthropicMessagesUrl(apiUrl: string): string {
  const raw = String(apiUrl ?? '').trim();
  try {
    const u = new URL(raw || 'https://api.anthropic.com');
    let host = u.hostname;
    let path = u.pathname.replace(/\/+$/, '') || '';

    if (/minimax/i.test(host) || looksLikeMiniMaxChat(raw, '')) {
      if (/^api\.minimax\.chat$/i.test(host)) host = 'api.minimax.io';
      if (!/minimax/i.test(host)) {
        host = /minimaxi\.com/i.test(raw) ? 'api.minimaxi.com' : 'api.minimax.io';
      }
      return `${u.protocol}//${host}/anthropic/v1/messages`;
    }

    if (/\/v1\/messages$/i.test(path)) {
      return `${u.protocol}//${host}${path}`;
    }
    if (/\/anthropic$/i.test(path)) {
      return `${u.protocol}//${host}${path}/v1/messages`;
    }
    if (/\/anthropic\/v1$/i.test(path)) {
      return `${u.protocol}//${host}${path}/messages`;
    }
    if (/\/chat\/completions$/i.test(path)) {
      path = path.replace(/\/chat\/completions$/i, '');
    }
    if (/\/v1$/i.test(path)) {
      return `${u.protocol}//${host}${path}/messages`;
    }
    if (!path || path === '/') {
      return `${u.protocol}//${host}/v1/messages`;
    }
    return `${u.protocol}//${host}${path}/v1/messages`;
  } catch {
    return 'https://api.anthropic.com/v1/messages';
  }
}

/** Anthropic 鉴权：官方 Claude 用 x-api-key；MiniMax / 多数兼容网关用 Bearer */
export function buildAnthropicAuthHeaders(opts: {
  apiKey?: string;
  provider?: string;
  apiUrl?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  const key = String(opts.apiKey ?? '').trim();
  if (!key) return headers;

  const useXApiKey =
    opts.provider === 'claude' ||
    (/\banthropic\.com\b/i.test(String(opts.apiUrl ?? '')) &&
      !looksLikeMiniMaxChat(opts.apiUrl ?? '', ''));

  if (useXApiKey) {
    headers['x-api-key'] = key;
  } else {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

/** Anthropic 请求体中的 thinking 字段 */
export function buildAnthropicThinkingParams(opts: {
  apiUrl?: string;
  modelName?: string;
  provider?: string;
  maxTokens?: number;
}): { thinking: Record<string, unknown> } {
  const isClaudeOfficial =
    opts.provider === 'claude' || /\banthropic\.com\b/i.test(String(opts.apiUrl ?? ''));
  if (isClaudeOfficial) {
    const max = opts.maxTokens ?? 4096;
    return {
      thinking: {
        type: 'enabled',
        budget_tokens: Math.min(Math.max(max - 1000, 1024), 16000),
      },
    };
  }
  /** 非 Claude 的 Anthropic 兼容网关：用 adaptive 开启 thinking */
  return { thinking: { type: 'adaptive' } };
}

export function parseAnthropicContentBlocks(data: unknown): {
  content: string;
  reasoning?: string;
  usage?: unknown;
} {
  const root = data as {
    type?: string;
    error?: unknown;
    content?: Array<{ type?: string; text?: string; thinking?: string }>;
    usage?: unknown;
  };
  if (root?.type === 'error') {
    throw new Error(
      typeof root.error === 'string' ? root.error : JSON.stringify(root.error ?? root)
    );
  }
  const blocks = Array.isArray(root?.content) ? root.content : [];
  const reasoning = blocks
    .filter((b) => b.type === 'thinking' && typeof b.thinking === 'string')
    .map((b) => b.thinking as string)
    .join('\n');
  const content = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
  return {
    content: content || '',
    ...(reasoning.trim() ? { reasoning } : {}),
    usage: root?.usage,
  };
}
