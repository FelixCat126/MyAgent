/** 联网搜索提供商（DuckDuckGo 无需 Key；Tavily / Brave 需 API Key） */
export type WebSearchProvider = 'duckduckgo' | 'tavily' | 'brave';

export interface WebSearchRequest {
  query: string;
  provider: WebSearchProvider;
  apiKey?: string;
}

export interface WebSearchResponse {
  ok: boolean;
  text: string;
  error?: string;
}