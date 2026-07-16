export function formatAxiosGenerateHttpError(
  endpoint: string,
  status: number,
  bodyBuf: ArrayBuffer | Buffer | Uint8Array,
  providerHint?: string
): string {
  const raw = (Buffer.isBuffer(bodyBuf)
    ? bodyBuf
    : Buffer.from(bodyBuf instanceof ArrayBuffer ? new Uint8Array(bodyBuf) : bodyBuf)
  )
    .toString('utf8')
    .slice(0, 1400)
    .trim();
  if (!raw) {
    /** 无响应体：按厂商给出针对性排查提示，避免一律显示 Ollama 模板 */
    if (providerHint) {
      return `请求 ${endpoint} 返回 HTTP ${status}（无响应体）。${providerHint}`;
    }
    return `请求 ${endpoint} 返回 HTTP ${status}（无响应体）；请核对 OLLAMA_MODEL、接口是否为 /api/generate，并将 Ollama 升级到支持生图的版本`;
  }
  try {
    const j = JSON.parse(raw) as { error?: unknown; code?: unknown; message?: unknown; request_id?: unknown };
    /** 百炼/DashScope 错误格式：{ code, message, request_id } */
    if (typeof j.code === 'string' && typeof j.message === 'string') {
      const rid = typeof j.request_id === 'string' ? `（request_id: ${j.request_id}）` : '';
      return `HTTP ${status} [${j.code}]：${j.message}${rid}`;
    }
    if (typeof j.error === 'string') return `HTTP ${status}：${j.error}`;
    if (j.error !== undefined && j.error !== null) {
      return `HTTP ${status}：${JSON.stringify(j.error).slice(0, 800)}`;
    }
    /** 有 message 但无 code/error（部分网关） */
    if (typeof j.message === 'string') return `HTTP ${status}：${j.message}`;
  } catch {
    /* 非 JSON */
  }
  return `HTTP ${status}：${raw.slice(0, 900)}`;
}

/** 百炼/万相 404 等常见错误的排查提示 */
export function bailianHttpErrorHint(endpoint: string): string {
  const full = 'dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
  if (/\/api\/v1\/?$/.test(endpoint) && !endpoint.includes('services')) {
    return `接口地址不完整：wan2.6 同步调用需要完整路径 \`${full}\`，请在「高级」中补全 endpoint。`;
  }
  if (/image-synthesis/i.test(endpoint)) {
    return `当前用的是旧版异步接口 image-synthesis（返回 task_id，需轮询）。wan2.6 同步请改用 \`${full}\`。`;
  }
  return `请核对接口地址是否为 \`/services/aigc/multimodal-generation/generation\`、模型名是否为 \`wan2.6-t2i\`、API Key 是否为有效的 DashScope Key。`;
}
