import type { Locale } from '../i18n/types';
import type { Message, ModelConfig } from '../types';
import { agentBrowserOpen, agentBrowserRead } from './browser/agentBrowserController';
import { useAgentBrowserStore } from '../store/agentBrowserStore';
import { callModelAgentRound } from './callModelAgentRound';

export type WebBrowseIntent =
  | { kind: 'baidu_search'; query: string }
  | { kind: 'google_search'; query: string }
  | { kind: 'open_url'; url: string };

const OPEN_BAIDU_RE = /打开百度(?:首页|网站)?/i;
const BaiduSearchRes = [
  /(?:打开百度|在百度|百度上|用百度)[^。\n]{0,40}?(?:搜索|搜一下|搜|查)\s*[「『"'""]([^」』"'""]+)[」』"'""]/,
  /(?:打开百度|在百度|百度上|用百度)[^。\n]{0,40}?(?:搜索|搜一下|搜|查)\s*['"]([^'"]+)['"]/,
  /(?:打开百度|在百度|百度上|用百度)[^。\n]{0,40}?(?:搜索|搜一下|搜|查)\s*([^\s，,。！!？?\n""''「『]{1,20})/,
];

/** 用户要求从网页取第一张/返回图片 */
export function userWantsWebFirstImage(text: string): boolean {
  const t = String(text || '');
  return /第一张|第\s*[1一1]\s*张|[1一]张图|返回.{0,16}(图|照片|图片)|给我.{0,12}(图|照片|图片)|把.{0,16}(图|照片|图片).{0,8}(发|给|贴|返回|弄)/i.test(
    t
  );
}

/** 用户要在网页上继续操作（点图片、取结果等），不能只打开搜索页就结束 */
export function needsWebAgentWorkflow(text: string): boolean {
  const t = String(text || '');
  return /进入.{0,8}图片|图片.{0,8}(搜索|结果|频道|tab)|图片搜索|第一张|第\s*[1一1]\s*张|[1一]张图|返回.{0,16}(图|照片|图片)|给我.{0,12}(图|照片|图片)|下载.{0,8}图|把.{0,16}(图|照片|图片).{0,8}(发|给|贴|返回|弄)|点开.{0,8}(图|结果|链接)|点击.{0,8}(图|图片|结果)/i.test(
    t
  );
}

/** 从「搜索/搜」后提取关键词：优先引号内，否则取到逗号/句号前 */
export function extractSearchQuery(text: string): string | null {
  const t = String(text || '').trim();
  for (const re of BaiduSearchRes) {
    const m = t.match(re);
    const q = m?.[1]?.trim().replace(/^[「『"'""]+|[」』"'""]+$/g, '').trim();
    if (q && q.length >= 1) return q.slice(0, 40);
  }
  const google = t.match(
    /(?:打开)?谷歌[^。\n]{0,24}?(?:搜索|搜|查)\s*[「『"'""]([^」』"'""]+)[」』"'""]/i
  );
  if (google?.[1]?.trim()) return google[1].trim().slice(0, 40);
  const googleBare = t.match(
    /(?:打开)?谷歌[^。\n]{0,24}?(?:搜索|搜|查)\s*['"]?([^，,。！!？?\n""''「『]{1,20})/i
  );
  if (googleBare?.[1]?.trim()) {
    return googleBare[1].trim().replace(/^[「『"'""]+|[」』"'""]+$/g, '').slice(0, 40);
  }
  return null;
}

/** 仅「打开搜索/首页」类请求可走快速路径；含后续网页操作须进 Agent 工具链 */
export function isSimpleWebBrowseOnly(text: string, intent: WebBrowseIntent | null): boolean {
  if (!intent) return false;
  return !needsWebAgentWorkflow(text);
}

export function buildBaiduImageSearchUrl(query: string): string {
  return `https://image.baidu.com/search/index?tn=baiduimage&word=${encodeURIComponent(query)}`;
}

export function buildGoogleImageSearchUrl(query: string): string {
  return `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(query)}`;
}

/** 根据用户话术选择普通网页搜索或图片搜索 URL */
export function resolveWebBrowseOpenUrl(intent: WebBrowseIntent, userText: string): string {
  const wantsImage =
    /图片|照片|相片|image/i.test(userText) ||
    userWantsWebFirstImage(userText) ||
    /进入.{0,8}图片|图片搜索|image\s*search/i.test(userText);
  if (intent.kind === 'baidu_search' && wantsImage) {
    return buildBaiduImageSearchUrl(intent.query);
  }
  if (intent.kind === 'google_search' && wantsImage) {
    return buildGoogleImageSearchUrl(intent.query);
  }
  return buildWebBrowseUrl(intent);
}

const WEB_PAGE_RE = /网站|网页|web\s*site|webpage|homepage|站点/i;

/** 用户想打开网页并了解「这是什么网站/做什么」 */
export function userWantsWebPageDescription(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;
  return (
    /什么网站|是什么站|做什么|干什么|做啥的|干啥|介绍.{0,10}(网站|网页)|网站.{0,16}(是什么|做什么|干什么|干啥|介绍)|tell me what (?:this|the) (?:site|website)/i.test(
      t
    ) || (WEB_PAGE_RE.test(t) && /告诉|说明|介绍|是什么|做什么|summarize|describe/i.test(t))
  );
}

/** 从用户话术中提取 http(s) URL 或域名 */
export function extractUrlFromUserText(text: string): string | null {
  const t = String(text || '').trim();
  const direct = t.match(/https?:\/\/[^\s，,。！!？?<>]+/i);
  if (direct?.[0]) return direct[0].replace(/[)\]}>]+$/, '');
  const quoted = t.match(/[「『"'""](https?:\/\/[^」』"'""]+)[」』"'""]/i);
  if (quoted?.[1]) return quoted[1];
  const domain =
    t.match(
      /(?:打开|访问|浏览|看看|去)\s*(?:一下\s*)?(?:这个\s*)?(?:网站\s*)?[\s:：]*([a-z0-9][-a-z0-9.]*\.[a-z]{2,}(?:\/[^\s，,。！!？?]*)?)/i
    ) ?? t.match(/\b([a-z0-9][-a-z0-9.]*\.[a-z]{2,}(?:\/[^\s，,。！!？?]*)?)\b/i);
  if (domain?.[1] && !/\.(md|txt|docx|xlsx|pdf)$/i.test(domain[1])) {
    return domain[1].startsWith('http') ? domain[1] : `https://${domain[1]}`;
  }
  return null;
}

export function looksLikeWebBrowseRequest(text: string): boolean {
  return parseWebBrowseIntent(text) !== null || userWantsWebPageDescription(text);
}

export function parseWebBrowseIntent(text: string): WebBrowseIntent | null {
  const t = String(text || '').trim();
  if (!t) return null;

  const baiduQ = extractSearchQuery(t);
  if (baiduQ && /(?:打开\s*)?百度|在百度|百度上|用百度/i.test(t) && /(?:搜索|搜|查)/.test(t)) {
    return { kind: 'baidu_search', query: baiduQ };
  }

  const googleQ = extractSearchQuery(t);
  if (googleQ && /(?:打开\s*)?谷歌|google/i.test(t) && /(?:搜索|搜|查)/i.test(t)) {
    return { kind: 'google_search', query: googleQ };
  }

  const urlOpen = t.match(/打开\s*(https?:\/\/[^\s，,。]+)/i);
  if (urlOpen?.[1]) return { kind: 'open_url', url: urlOpen[1].trim() };

  if (OPEN_BAIDU_RE.test(t) && !/(?:搜索|搜|查)/.test(t)) {
    return { kind: 'open_url', url: 'https://www.baidu.com/' };
  }

  return null;
}

export function buildWebBrowseUrl(intent: WebBrowseIntent): string {
  switch (intent.kind) {
    case 'baidu_search':
      return `https://www.baidu.com/s?wd=${encodeURIComponent(intent.query)}`;
    case 'google_search':
      return `https://www.google.com/search?q=${encodeURIComponent(intent.query)}`;
    case 'open_url':
      return intent.url;
  }
}

export async function executeWebBrowseIntent(
  intent: WebBrowseIntent,
  locale: Locale,
  userText?: string,
  opts?: { shouldCancel?: () => boolean }
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const url = userText ? resolveWebBrowseOpenUrl(intent, userText) : buildWebBrowseUrl(intent);
  const r = await agentBrowserOpen(url, { shouldCancel: opts?.shouldCancel });
  if (!r.ok) return r;

  if (intent.kind === 'baidu_search') {
    return {
      ok: true,
      message:
        locale === 'en'
          ? `Opened Baidu search for 「${intent.query}」 in the panel below.`
          : `已在对话区下方打开百度搜索「${intent.query}」。`,
    };
  }
  if (intent.kind === 'google_search') {
    return {
      ok: true,
      message:
        locale === 'en'
          ? `Opened Google search for 「${intent.query}」 in the panel below.`
          : `已在对话区下方打开 Google 搜索「${intent.query}」。`,
    };
  }
  return {
    ok: true,
    message:
      locale === 'en'
        ? `Opened ${r.title || r.url} in the panel below.`
        : `已在对话区下方打开：${r.title || r.url}`,
  };
}

async function summarizeWebSnapshot(
  snapshot: string,
  userText: string,
  model: ModelConfig,
  locale: Locale,
  handlers?: {
    onThinkingDelta?: (chunk: string) => void;
    onContentDelta?: (chunk: string) => void;
    shouldCancel?: () => boolean;
  }
): Promise<{ content: string; reasoning?: string }> {
  const messages: Message[] = [
    {
      id: `web-desc-sys-${Date.now()}`,
      role: 'system',
      content:
        locale === 'en'
          ? 'You received a snapshot of a web page (title + visible text). In 2–4 sentences, explain what this website is and what it is for. Use ONLY the snapshot; do not invent. If the snapshot is empty or blocked, say so plainly.'
          : '你收到的是网页快照（标题+可见正文）。请用 2～4 句话说明这是什么网站、主要做什么；只能依据快照，禁止编造。若快照为空或被拦截，请直接说明。',
      timestamp: Date.now(),
      model: 'web-describe',
    },
    {
      id: `web-desc-user-${Date.now()}`,
      role: 'user',
      content: `用户问题：${userText}\n\n【网页快照】\n${snapshot}`,
      timestamp: Date.now(),
      model: model.name,
    },
  ];
  const r = await callModelAgentRound(messages, model, locale, {
    onThinkingDelta: handlers?.onThinkingDelta,
    onDelta: handlers?.onContentDelta,
    shouldCancel: handlers?.shouldCancel,
  });
  const content = String(r.content ?? '').trim();
  const fallback =
    locale === 'en' ? 'Could not extract enough from the page.' : '未能从页面提取到足够信息。';
  return {
    content: content || fallback,
    ...(r.reasoning?.trim() ? { reasoning: r.reasoning.trim() } : {}),
  };
}

export type WebPageDescribeHandlers = {
  onThinkingDelta?: (chunk: string) => void;
  onContentDelta?: (chunk: string) => void;
  onReplyContent?: (text: string) => void;
  shouldCancel?: () => boolean;
};

function formatOpenedPanelHead(
  page: { url: string; title?: string },
  locale: Locale
): string {
  let label = page.url;
  try {
    const u = new URL(page.url);
    const host = u.hostname.replace(/^www\./i, '');
    const title = (page.title || '').trim();
    label = title ? `${title} | ${host}` : host || page.url;
  } catch {
    label = (page.title || '').trim() || page.url;
  }
  return locale === 'en'
    ? `Opened in the panel below: ${label}\n\n`
    : `已在下方打开：${label}\n\n`;
}

/** 打开 URL → web_read 抓正文 → 模型总结「这是什么网站」 */
export async function executeWebPageDescribe(
  url: string,
  userText: string,
  model: ModelConfig,
  locale: Locale,
  handlers?: WebPageDescribeHandlers
): Promise<{ ok: true; message: string; reasoning?: string } | { ok: false; error: string }> {
  /** 后台加载页面，对话区保持「···」直到进入分析/回答流 */
  const opened = await agentBrowserOpen(url, {
    revealPanel: false,
    shouldCancel: handlers?.shouldCancel,
  });
  if (!opened.ok) return opened;

  const read = await agentBrowserRead({ maxChars: 8000, shouldCancel: handlers?.shouldCancel });
  if (!read.ok) {
    useAgentBrowserStore.getState().reveal();
    return {
      ok: false,
      error:
        read.error === 'AGENT_CANCELLED' || handlers?.shouldCancel?.()
          ? 'AGENT_CANCELLED'
          : locale === 'en'
          ? `Page opened but could not read content: ${read.error}`
          : `页面已打开，但读取内容失败：${read.error}`,
    };
  }

  const body = (read.text ?? '').trim();
  const snapshot =
    `URL: ${read.url}\n标题: ${read.title || opened.title || ''}\n\n` +
    (body || '（页面可见正文为空，可能仍在加载或被站点限制）');

  const head = formatOpenedPanelHead(
    { url: read.url, title: read.title || opened.title },
    locale
  );

  let streamedSummary = '';
  let panelRevealed = false;
  const revealPanelOnce = (): void => {
    if (panelRevealed) return;
    panelRevealed = true;
    useAgentBrowserStore.getState().reveal();
  };

  const { content: summary, reasoning } = await summarizeWebSnapshot(
    snapshot,
    userText,
    model,
    locale,
    {
      onThinkingDelta: handlers?.onThinkingDelta,
      onContentDelta: (chunk) => {
        if (handlers?.shouldCancel?.()) return;
        if (!chunk) return;
        revealPanelOnce();
        streamedSummary += chunk;
        handlers?.onReplyContent?.(head + streamedSummary);
      },
      shouldCancel: handlers?.shouldCancel,
    }
  );

  revealPanelOnce();
  const message = head + summary;
  handlers?.onReplyContent?.(message);
  return { ok: true, message, ...(reasoning ? { reasoning } : {}) };
}

export function buildWebBrowseMissingUrlMessage(locale: Locale): string {
  return locale === 'en'
    ? 'Please provide a URL (e.g. https://example.com) so I can open it and tell you what the site is about.'
    : '请提供具体网址（例如 https://example.com），我才能打开并用 web_read 读取页面后说明这是什么网站。';
}
