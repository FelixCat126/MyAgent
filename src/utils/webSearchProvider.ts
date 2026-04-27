/** 与主进程 web-search IPC 中逻辑一致，便于单测与复用 */
export function normalizeWebSearchProvider(p: string): 'duckduckgo' | 'tavily' | 'brave' {
  const s = String(p || 'duckduckgo').toLowerCase();
  if (s === 'tavily') return 'tavily';
  if (s === 'brave') return 'brave';
  return 'duckduckgo';
}
