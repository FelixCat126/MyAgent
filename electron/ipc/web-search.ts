import { ipcMain } from 'electron';
import axios from 'axios';
import type { WebSearchRequest, WebSearchResponse } from '../../src/types';
import { normalizeWebSearchProvider } from '../../src/utils/webSearchProvider';

const UA = 'MyAgent/1.0 (Electron; +https://github.com/)';

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…（已截断）`;
}

function stripHtmlLite(s: string): string {
  return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function searchDuckDuckGo(query: string): Promise<string> {
  const url = 'https://api.duckduckgo.com/';
  const { data } = await axios.get(url, {
    params: { q: query, format: 'json', no_html: 1, skip_disambig: 1, no_redirect: 1 },
    timeout: 20000,
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  const parts: string[] = [];
  if (data.Answer) {
    parts.push(`即时答复: ${String(data.Answer)}`);
  }
  if (data.AbstractText) {
    const line = data.AbstractURL
      ? `${data.AbstractText}\n来源: ${data.AbstractURL}`
      : String(data.AbstractText);
    parts.push(line);
  }
  const topics = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
  for (const t of topics.slice(0, 10)) {
    if (t && typeof t === 'object' && 'Text' in t && t.Text) {
      const u = 'FirstURL' in t && t.FirstURL ? `\n  ${t.FirstURL}` : '';
      parts.push(`- ${t.Text}${u}`);
    }
  }
  const results = Array.isArray(data.Results) ? data.Results : [];
  for (const r of results.slice(0, 10)) {
    if (!r || typeof r !== 'object') continue;
    const url0 = r.FirstURL as string | undefined;
    const title = (r.Text as string) || (r.Name as string) || stripHtmlLite(String(r.Result || ''));
    if (title && url0) parts.push(`- ${title}\n  ${url0}`);
    else if (title) parts.push(`- ${title}`);
  }
  return parts.join('\n').trim();
}

/** DuckDuckGo Lite 网页版：免 Key，中文/网页结果通常优于 Instant Answer JSON */
async function searchDuckDuckGoLite(query: string): Promise<string> {
  try {
    const { data: html } = await axios.get<string>('https://lite.duckduckgo.com/lite/', {
      params: { q: query.slice(0, 500) },
      timeout: 22000,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      },
      responseType: 'text',
      maxRedirects: 5,
    });
    const lines: string[] = [
      '（以下为 DuckDuckGo Lite 网页结果线索；时效与排序以搜索引擎为准）',
    ];
    const seen = new Set<string>();
    const re = /href="[^"]*?uddg=([^"&]+)[^"]*"/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      try {
        const decoded = decodeURIComponent(m[1]);
        if (!decoded.startsWith('http')) continue;
        if (seen.has(decoded)) continue;
        seen.add(decoded);
        lines.push(`- ${decoded}`);
        if (seen.size >= 14) break;
      } catch {
        /* skip bad escape */
      }
    }
    return lines.length > 1 ? lines.join('\n').trim() : '';
  } catch (e) {
    console.warn('[web-search] DDG Lite', e);
    return '';
  }
}

/** 英文维基：补充英文实体 / 技术词条 */
async function searchWikipediaEnTitles(query: string): Promise<string> {
  const { data } = await axios.get('https://en.wikipedia.org/w/api.php', {
    params: {
      action: 'opensearch',
      search: query.slice(0, 200),
      limit: 8,
      namespace: 0,
      format: 'json',
      origin: '*',
    },
    timeout: 18000,
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (!Array.isArray(data) || data.length < 4) return '';
  const titles = data[1] as unknown;
  const descs = data[2] as unknown;
  const urls = data[3] as unknown;
  if (!Array.isArray(titles) || titles.length === 0) return '';
  const lines: string[] = ['（英文维基百科相关条目，可作背景参考）'];
  const dArr = Array.isArray(descs) ? descs : [];
  const uArr = Array.isArray(urls) ? urls : [];
  for (let i = 0; i < titles.length; i++) {
    const t = String(titles[i] ?? '');
    const d = String(dArr[i] ?? '');
    const u = String(uArr[i] ?? '');
    lines.push(`【${t}】${d}\n${u}`);
  }
  return lines.join('\n\n').trim();
}

/** DuckDuckGo 对中文新闻常为空时，用语维基标题检索补充线索（非实时新闻） */
async function searchWikipediaZhTitles(query: string): Promise<string> {
  const { data } = await axios.get('https://zh.wikipedia.org/w/api.php', {
    params: {
      action: 'opensearch',
      search: query.slice(0, 200),
      limit: 8,
      namespace: 0,
      format: 'json',
      origin: '*',
    },
    timeout: 18000,
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (!Array.isArray(data) || data.length < 4) return '';
  const titles = data[1] as unknown;
  const descs = data[2] as unknown;
  const urls = data[3] as unknown;
  if (!Array.isArray(titles) || titles.length === 0) return '';
  const lines: string[] = ['（中文维基百科相关条目，可作主题线索；非即时新闻头条）'];
  const dArr = Array.isArray(descs) ? descs : [];
  const uArr = Array.isArray(urls) ? urls : [];
  for (let i = 0; i < titles.length; i++) {
    const t = String(titles[i] ?? '');
    const d = String(dArr[i] ?? '');
    const u = String(uArr[i] ?? '');
    lines.push(`【${t}】${d}\n${u}`);
  }
  return lines.join('\n\n').trim();
}

async function searchTavily(query: string, apiKey: string): Promise<string> {
  if (!apiKey.trim()) {
    throw new Error('Tavily 需要填写 API Key（https://tavily.com）');
  }
  const { data } = await axios.post(
    'https://api.tavily.com/search',
    {
      api_key: apiKey,
      query,
      search_depth: 'basic',
      max_results: 8,
      include_answer: true,
    },
    { timeout: 25000, headers: { 'Content-Type': 'application/json', 'User-Agent': UA } }
  );
  const chunks: string[] = [];
  if (data.answer) chunks.push(`概要: ${data.answer}`);
  const results = Array.isArray(data.results) ? data.results : [];
  for (const r of results) {
    if (!r) continue;
    const title = r.title || '';
    const url = r.url || '';
    const content = r.content || r.snippet || '';
    chunks.push(`【${title}】\n${url}\n${content}`);
  }
  return chunks.join('\n\n').trim();
}

async function searchBrave(query: string, apiKey: string): Promise<string> {
  if (!apiKey.trim()) {
    throw new Error('Brave Search 需要填写 API Key（https://brave.com/search/api）');
  }
  const { data } = await axios.get('https://api.search.brave.com/res/v1/web/search', {
    params: { q: query, count: 10, text_decorations: 0, extra_snippets: 1 },
    timeout: 25000,
    headers: { 'X-Subscription-Token': apiKey, 'User-Agent': UA, Accept: 'application/json' },
  });
  const web = data.web?.results;
  if (!Array.isArray(web)) return '';
  const chunks: string[] = [];
  for (const r of web) {
    const desc = [r.description, ...(r.extra_snippets || [])].filter(Boolean).join(' ');
    chunks.push(`【${r.title || ''}】\n${r.url || ''}\n${desc}`);
  }
  return chunks.join('\n\n').trim();
}

ipcMain.handle(
  'web-search',
  async (_event, payload: WebSearchRequest): Promise<WebSearchResponse> => {
    const q = (payload.query || '').trim().slice(0, 800);
    if (!q) {
      return { ok: false, text: '', error: '搜索词为空' };
    }
    const provider = normalizeWebSearchProvider(String(payload.provider));
    try {
      let text = '';
      if (provider === 'tavily') {
        text = await searchTavily(q, payload.apiKey || '');
      } else if (provider === 'brave') {
        text = await searchBrave(q, payload.apiKey || '');
      } else {
        text = await searchDuckDuckGo(q);
        if (!text) {
          const wikiZh = await searchWikipediaZhTitles(q);
          if (wikiZh) text = wikiZh;
        }
        if (!text) {
          const wikiEn = await searchWikipediaEnTitles(q);
          if (wikiEn) text = wikiEn;
        }
        if (!text) {
          text = await searchDuckDuckGoLite(q);
        }
      }
      text = truncate(text, 14000);
      if (!text) {
        return { ok: true, text: '', error: '未返回有效摘要，可换用 Tavily/Brave 或调整提问。' };
      }
      return { ok: true, text };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[web-search]', msg);
      return { ok: false, text: '', error: msg };
    }
  }
);

console.log('✅ 联网搜索 IPC 已注册');
