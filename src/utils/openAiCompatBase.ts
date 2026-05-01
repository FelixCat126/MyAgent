/** Ollama 默认只监听 IPv4；Node 将 localhost 解析为 ::1 时会出现 ECONNREFUSED */
function normalizeOllamaLoopbackHosts(trimmed: string): string {
  return trimmed.replace(
    /^((?:https?):\/\/)(localhost|\[::1\])(?=:\d|[/?#]|$)/i,
    (_, scheme: string) => `${scheme}127.0.0.1`
  );
}

/** Ollama OpenAI 兼容基址：见 `electron/ipc/model.ts` 中用法 */
export function resolveOpenAiCompatibleBaseUrl(apiUrl: string, provider: string): string {
  let trimmed = apiUrl.trim().replace(/\/$/, '');
  if (provider === 'ollama') trimmed = normalizeOllamaLoopbackHosts(trimmed);
  if (provider !== 'ollama') return trimmed;
  if (/\/v1(\/|$)/.test(trimmed)) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.pathname === '/' || parsed.pathname === '') {
      return `${trimmed}/v1`;
    }
  } catch {
    /* 非标准 URL 时原样返回 */
  }
  return trimmed;
}
