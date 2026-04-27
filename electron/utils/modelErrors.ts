/**
 * 将 API / 网络错误转为用户可读的简体中文提示（可观测性）
 */
export function mapModelCallError(err: unknown): string {
  const e = err as {
    code?: string;
    message?: string;
    response?: { status?: number; data?: unknown; statusText?: string };
  };

  if (e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT') {
    return '请求超时：请检查网络、代理或把模型服务地址改为可访问的端点。';
  }
  if (e?.code === 'ECONNREFUSED' || e?.code === 'ENOTFOUND') {
    return '无法连接服务：请确认 API 地址、本机服务是否已启动、DNS/代理是否正常。';
  }
  if (e?.code === 'ENOENT') {
    return e?.message?.includes('附件') ? e.message : '本地文件不存在，请重新上传附件后重试。';
  }

  const status = e?.response?.status;
  const data = e?.response?.data as
    | { error?: { message?: string; type?: string } | string }
    | { message?: string }
    | string
    | undefined;

  const extractMsg = (): string => {
    if (!data) return e?.message || '未知错误';
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
    return '认证失败 (401)：请检查 API Key 是否正确、是否已过期。';
  }
  if (status === 403) {
    return '拒绝访问 (403)：可能是 Key 无权限、地区限制或安全策略。';
  }
  if (status === 404) {
    return '未找到 (404)：请检查 API 基地址、路径或模型名是否正确。';
  }
  if (status === 429) {
    return '请求过频 (429)：请稍后再试或升级服务商配额/更换 Key。';
  }
  if (status === 502 || status === 503 || status === 504) {
    return `服务暂不可用 (${status})：对端或网关繁忙，请稍后重试。`;
  }

  const text = extractMsg();
  const low = String(text).toLowerCase();
  if (
    low.includes('content policy') ||
    low.includes('safety') ||
    low.includes('content_filter') ||
    (low.includes('违规') && low.includes('内容'))
  ) {
    return `内容被策略拦截：${text}`;
  }
  if (low.includes('context') && low.includes('length')) {
    return `上下文过长：请缩短对话或开启新会话。原文：${text}`;
  }
  if (e?.message) {
    return e.message;
  }
  return text || '模型调用失败';
}
