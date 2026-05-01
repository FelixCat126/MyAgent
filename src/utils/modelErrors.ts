import type { Locale } from '../i18n/types';

const MSGS: Record<
  Locale,
  {
    timeout: string;
    conn: string;
    localFile: string;
    auth: string;
    forbidden: string;
    notFound: string;
    rate: string;
    badGateway: string;
    unknown: string;
    fail: string;
    policy: (t: string) => string;
    context: (t: string) => string;
  }
> = {
  zh: {
    timeout: '请求超时：请检查网络、代理或把模型服务地址改为可访问的端点。',
    conn: '无法连接服务：请确认 API 地址、本机服务是否已启动、DNS/代理是否正常。',
    localFile: '本地文件不存在，请重新上传附件后重试。',
    auth: '认证失败 (401)：请检查 API Key 是否正确、是否已过期。',
    forbidden: '拒绝访问 (403)：可能是 Key 无权限、地区限制或安全策略。',
    notFound: '未找到 (404)：请检查 API 基地址、路径或模型名是否正确。',
    rate: '请求过频 (429)：请稍后再试或升级服务商配额/更换 Key。',
    badGateway: '服务暂不可用 ({status})：对端或网关繁忙，请稍后重试。',
    unknown: '未知错误',
    fail: '模型调用失败',
    policy: (t) => `内容被策略拦截：${t}`,
    context: (t) => `上下文过长：请缩短对话或开启新会话。原文：${t}`,
  },
  en: {
    timeout: 'Request timed out. Check network, proxy, or API URL.',
    conn: 'Cannot reach the service. Check the API URL, local service, DNS/proxy.',
    localFile: 'Local file missing. Re-upload the attachment and try again.',
    auth: 'Authentication failed (401). Check your API key.',
    forbidden: 'Access denied (403). Key permissions, region, or policy may block this.',
    notFound: 'Not found (404). Check the base URL, path, and model name.',
    rate: 'Rate limited (429). Retry later or change quota/key.',
    badGateway: 'Service temporarily unavailable ({status}). Try again later.',
    unknown: 'Unknown error',
    fail: 'Model request failed',
    policy: (t) => `Blocked by content policy: ${t}`,
    context: (t) => `Context too long. Shorten the chat or start a new session. ${t}`,
  },
};

/** API / 网络错误转用户可读文案 */
export function mapModelCallError(err: unknown, locale: Locale = 'zh'): string {
  const L = MSGS[locale] ?? MSGS.zh;
  const e = err as {
    code?: string;
    message?: string;
    response?: { status?: number; data?: unknown; statusText?: string };
  };

  if (e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT') {
    return L.timeout;
  }
  if (
    e?.code === 'ECONNREFUSED' ||
    e?.code === 'ENOTFOUND' ||
    e?.code === 'ERR_NETWORK' ||
    e?.code === 'ECONNRESET' ||
    e?.code === 'EPIPE' ||
    e?.code === 'EPROTO'
  ) {
    return L.conn;
  }
  if (e?.code === 'ENOENT') {
    return e?.message?.includes('附件') || e?.message?.includes('ATTACH') ? e.message : L.localFile;
  }

  const status = e?.response?.status;
  const data = e?.response?.data as
    | { error?: { message?: string; type?: string } | string }
    | { message?: string }
    | string
    | undefined;

  const extractMsg = (): string => {
    if (!data) return e?.message || L.unknown;
    if (typeof data === 'string') return data;
    if (typeof data === 'object' && 'error' in data && data.error) {
      const er = (data as { error: { message?: string } | string }).error;
      if (typeof er === 'string') return er;
      return er?.message || JSON.stringify(data);
    }
    if (typeof (data as { message?: string }).message === 'string') {
      return (data as { message: string }).message;
    }
    return JSON.stringify(data);
  };

  if (status === 401) {
    return L.auth;
  }
  if (status === 403) {
    return L.forbidden;
  }
  if (status === 404) {
    return L.notFound;
  }
  if (status === 429) {
    return L.rate;
  }
  if (status === 502 || status === 503 || status === 504) {
    return L.badGateway.replace('{status}', String(status));
  }

  const text = extractMsg();
  const low = String(text).toLowerCase();
  if (
    low.includes('content policy') ||
    low.includes('safety') ||
    low.includes('content_filter') ||
    (low.includes('违规') && low.includes('内容'))
  ) {
    return L.policy(text);
  }
  if (low.includes('context') && low.includes('length')) {
    return L.context(text);
  }
  if (e?.message) {
    return e.message;
  }
  return text || L.fail;
}
