/** Ollama OpenAI 兼容基址：见 `electron/ipc/model.ts` 中用法 */
export function resolveOpenAiCompatibleBaseUrl(apiUrl: string, provider: string): string {
  const trimmed = apiUrl.trim().replace(/\/$/, '');
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
