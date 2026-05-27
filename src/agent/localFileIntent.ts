import type { Message } from '../types';
import { looksLikeWebBrowseRequest } from './webBrowseIntent';

/** 用户是否在请求本机文件检索/阅读（Agent 应主动调工具） */
export function looksLikeLocalFileAgentRequest(text: string): boolean {
  const t = String(text || '').trim();
  if (t.length < 2) return false;
  if (looksLikeWebBrowseRequest(t)) return false;
  if (/^(你好|您好|hi|hello|谢谢|感谢)\b/i.test(t) && t.length < 12) return false;
  if (looksLikeLocalImageFindRequest(t)) return true;
  if (/网站|网页|web\s*site|webpage|https?:\/\//i.test(t)) return false;
  if (/百度|谷歌|google|baidu/i.test(t) && /(?:搜索|搜|打开|查)/.test(t)) return false;
  return /找|搜|查|列|读|打开|提取|摘要|总结|浏览|文档|文件|资料|xlsx|docx|pdf|\.md|txt|下载|桌面|Documents|Downloads|目录/i.test(
    t
  );
}

const LOCAL_SCOPE_RE =
  /本机|本地|电脑|磁盘|硬盘|这台|我的(?:电脑|机器|设备)|在我(?:的)?(?:电脑|机器|设备)?/i;
const LOCAL_FIND_RE = /找|搜|查|有没有|有无|看看|找找|是否存在|列出|查找|搜索/i;
const IMAGE_NOUN_RE =
  /照片|图片|相片|截图|壁纸|photo|picture|images?|png|jpe?g|webp|gif|bmp|heic/i;
const EXPLICIT_IMAGE_GEN_RE =
  /生成|画一?(?:张|幅|组)|绘制|生图|设计一?(?:张|幅)|generate|create|make\s+(?:an?\s+)?image|design\s+(?:an?\s+)?image/i;

/**
 * 用户要在本机查找**已有**图片并展示（非 AI 生图）。
 * 例：「在本机找有没有手表的照片，有的话贴出来（最多3张）」
 */
export function looksLikeLocalImageFindRequest(text: string): boolean {
  const t = String(text || '').trim();
  if (!t || !IMAGE_NOUN_RE.test(t)) return false;
  if (looksLikeWebBrowseRequest(t)) return false;
  if (/百度|谷歌|google|baidu/i.test(t) && /(?:搜索|搜|打开|进入)/.test(t)) return false;
  if (!LOCAL_FIND_RE.test(t)) return false;
  const hasLocalScope = LOCAL_SCOPE_RE.test(t);
  const wantsExisting =
    /有没有|有无|现成的|已有的|存在(?:的)?|贴出|发我|展示|显示|看看/i.test(t) &&
    LOCAL_SCOPE_RE.test(t);
  if (!hasLocalScope && !wantsExisting) return false;
  if (EXPLICIT_IMAGE_GEN_RE.test(t) && !/有没有|找一?(?:下|找)|搜一?(?:下|搜)|查找|搜索/i.test(t)) {
    return false;
  }
  return true;
}

/** 从用户话术中解析「最多贴几张图」 */
export function parseMaxImageAttachCount(text: string): number | undefined {
  const t = String(text || '');
  const explicit = t.match(/(?:最多|不超过|至多|max|limit)\s*(\d{1,2})\s*(?:张|个|幅)/i);
  if (explicit) {
    const n = parseInt(explicit[1], 10);
    if (Number.isFinite(n) && n > 0) return Math.min(12, n);
  }
  const zh = t.match(/(?:最多|不超过|至多)\s*([一二两三四五六七八九十])\s*(?:张|个|幅)/);
  if (zh) {
    const map: Record<string, number> = {
      一: 1,
      二: 2,
      两: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
      十: 10,
    };
    const n = map[zh[1]!];
    if (n) return Math.min(12, n);
  }
  return undefined;
}

const SEARCH_STOP_WORDS =
  /^(一篇|一段|不超过|里面|摘录|描写|相关|文档|文件|本机|本地|电脑|字数|一段话|在我|找|搜索|查找|有关|关于|摘录|段落|话|的|了|吗|呢)$/;

/** 从检索语句中提取主题词（用于校验语义命中是否相关） */
export function extractTopicKeywords(query: string): string[] {
  const kws = new Set<string>();
  const q = String(query || '').trim();
  if (!q) return [];

  const topicPatterns = [
    /描写([\u4e00-\u9fffA-Za-z0-9_.\-]{2,24})的/,
    /写([\u4e00-\u9fffA-Za-z0-9_.\-]{2,24})的/,
    /关于([\u4e00-\u9fffA-Za-z0-9_.\-]{2,24})的/,
    /有关([\u4e00-\u9fffA-Za-z0-9_.\-]{2,24})的/,
  ];
  for (const re of topicPatterns) {
    const m = q.match(re);
    if (m?.[1]?.trim()) kws.add(m[1].trim());
  }

  const words = q.match(/[\u4e00-\u9fffA-Za-z0-9_.\-]{2,}/g) ?? [];
  for (const w of words) {
    if (!SEARCH_STOP_WORDS.test(w)) kws.add(w);
  }
  return [...kws].slice(0, 6);
}

/**
 * 极简同义词表：仅覆盖最常见的本机文档检索场景，避免模型/文件名表述差异导致漏判。
 * 仅在 textMentionsTopicKeywords / 文件名搜索回退中扩展；不影响向模型展示的关键词。
 */
const TOPIC_SYNONYMS: Record<string, string[]> = {
  机械表: ['机械表', '腕表', '手表', '钟表', 'watch'],
  腕表: ['腕表', '机械表', '手表', 'watch'],
  手表: ['手表', '腕表', '机械表', 'watch'],
  watch: ['watch', '腕表', '机械表', '手表'],
  合同: ['合同', '协议', 'contract', 'agreement'],
  协议: ['协议', '合同', 'agreement', 'contract'],
  简历: ['简历', 'resume', 'cv'],
  发票: ['发票', 'invoice', '账单'],
  账单: ['账单', '发票', 'invoice', 'bill'],
};

export function expandTopicSynonyms(keyword: string): string[] {
  const k = String(keyword || '').trim();
  if (!k) return [];
  const lower = k.toLowerCase();
  for (const [key, syns] of Object.entries(TOPIC_SYNONYMS)) {
    if (key.toLowerCase() === lower) return [...new Set([k, ...syns])];
  }
  for (const [, syns] of Object.entries(TOPIC_SYNONYMS)) {
    if (syns.some((s) => s.toLowerCase() === lower)) {
      return [...new Set([k, ...syns])];
    }
  }
  return [k];
}

export function textMentionsTopicKeywords(text: string, query: string): boolean {
  const kws = extractTopicKeywords(query);
  if (!kws.length) return true;
  const hay = String(text || '').toLowerCase();
  for (const k of kws) {
    const variants = expandTopicSynonyms(k);
    if (variants.some((v) => hay.includes(v.toLowerCase()))) return true;
  }
  return false;
}

/** 从用户话术中提取 filename 搜索关键词 */
export function extractLocalSearchQuery(userText: string): string {
  const quoted = userText.match(/[「『"']([^」』"']+)[」』"']/);
  if (quoted?.[1]?.trim()) return quoted[1].trim().slice(0, 80);

  const topicPatterns = [
    /描写([\u4e00-\u9fffA-Za-z0-9_.\-]{2,24})的/,
    /写([\u4e00-\u9fffA-Za-z0-9_.\-]{2,24})的/,
    /关于([\u4e00-\u9fffA-Za-z0-9_.\-]{2,24})的/,
    /有关([\u4e00-\u9fffA-Za-z0-9_.\-]{2,24})的/,
  ];
  for (const re of topicPatterns) {
    const m = userText.match(re);
    if (m?.[1]?.trim()) return m[1].trim().slice(0, 80);
  }

  let q = userText
    .replace(/请(你|您)?/g, '')
    .replace(/帮(我|您)?/g, '')
    .replace(/(在)?(本机|本地|电脑|磁盘|硬盘|这台机器)(上|里|中|内)?/g, ' ')
    .replace(
      /(帮我|帮忙|查找|搜索|找一下|找下|找|列出|读取|打开|提取|摘要|总结|相关内容|相关文档|相关的文档|文档名称|文件名|文档|文件|照片|图片|相片|截图|壁纸)/g,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim();
  if (q.length >= 2) return q.slice(0, 80);

  const words = userText.match(/[\u4e00-\u9fffA-Za-z0-9_.\-]{2,}/g) ?? [];
  const picked = words.filter((w) => !SEARCH_STOP_WORDS.test(w)).slice(0, 4);
  if (picked.length === 1) return picked[0]!.slice(0, 80);
  return (picked.join(' ') || userText).trim().slice(0, 80);
}

/** 模型未调工具却让用户提供文档名/上传 */
export function modelDefersLocalFileWorkToUser(content: string, userText: string): boolean {
  if (!looksLikeLocalFileAgentRequest(userText)) return false;
  const c = content.trim();
  if (!c) return false;
  return (
    /上传|attach|upload|拖入|发给我|传给我/.test(c) ||
    /提供.{0,12}(文档|文件)/.test(c) ||
    /将.{0,16}(相关)?(文档|文件).{0,24}(内容)?(提供|发给|粘贴|上传)/.test(c) ||
    /说明.{0,12}(文档|文件).{0,12}名/.test(c) ||
    /告诉我.{0,12}(文件名|文档名|路径|名称)/.test(c) ||
    /才能.{0,4}为.{0,2}您.{0,8}(查找|提取|搜索|定位)/.test(c) ||
    /无法.{0,8}(查找|提取|读取|访问)/.test(c) ||
    /无法.{0,40}(搜索|查找|检索|定位)/.test(c) ||
    /(没有|未).{0,8}(找到|搜索到|检索到).{0,24}(文档|文件|资料)/.test(c) ||
    /please.{0,30}(provide|upload|filename|file name)/i.test(c) ||
    /need.{0,20}(file name|document name|you to provide)/i.test(c) ||
    /sorry.{0,30}(cannot|can't).{0,40}(search|find|access)/i.test(c)
  );
}

export function localSearchResultLooksEmpty(body: string): boolean {
  const b = String(body || '').trim();
  if (!b || b.startsWith('错误：')) return true;
  return /未找到|未命中|目录为空|no matching|not found/i.test(b);
}

export function buildEmptyLocalSearchFallbackDisplay(
  query: string,
  locale: 'zh' | 'en'
): string {
  if (locale === 'en') {
    return (
      `Searched your computer by filename for 「${query}」 but found no matching documents ` +
      '(.md, .txt, .docx, .xlsx, etc.). If the topic only appears inside file content, ' +
      'index a workspace for semantic search, or tell me a folder/path to list with local_list.'
    );
  }
  return (
    `已在您本机按**文件名**检索「${query}」，未找到匹配的文档（支持 .md/.txt/.docx/.xlsx 等）。` +
    '若关键词只在正文而不在文件名里，请为工作区建立索引以启用语义检索，或告诉我具体文件夹/路径以便列出文件。'
  );
}

/** 用户是否要求从文档中摘录/引用原文 */
export function userRequestsExcerpt(userText: string): boolean {
  return /摘录|引用|摘抄|抄录|原文|一句话|某句|某一句|不超过\s*\d+\s*字|不超过.{0,6}\d+\s*字/.test(
    String(userText || '')
  );
}

/**
 * 模型回答是否带"评论/建议/总结/改进"性内容——摘录场景下用来识别"越权点评"。
 * 命中关键词即可视为评论，不再要求结构匹配。
 */
const COMMENTARY_MARKERS = [
  '建议', '改进', '可以更', '更好', '不足', '问题在于', '总结', '总的来说',
  '综上', '点评', '评价', '我认为', '我觉得', '推荐', '此外', '另外',
  '需要注意', '值得注意', '优点', '缺点', '亮点', '深度', '可读性',
  '改写', '润色', '增加', '建议你', '更恰当', '更准确',
];

export function answerLooksLikeCommentary(content: string): boolean {
  const c = String(content || '').trim();
  if (!c) return false;
  if (c.length > 320) return true; // 摘录类回答应该很短；超过 320 字几乎必是综述
  for (const kw of COMMENTARY_MARKERS) {
    if (c.includes(kw)) return true;
  }
  return false;
}

/** 模型最终回答是否偏离用户本机检索主题（如续写历史里的地役权） */
export function answerDriftsFromUserTopic(content: string, userText: string): boolean {
  if (!looksLikeLocalFileAgentRequest(userText)) return false;
  const c = content.trim();
  if (!c || c.length < 60) return false;
  if (modelDefersLocalFileWorkToUser(c, userText)) return false;
  if (textMentionsTopicKeywords(c, userText)) return false;
  if (c.includes('已在您本机按**文件名**检索')) return false;
  return true;
}

/** Agent 编排只用当前用户句，避免会话历史里的无关话题劫持模型 */
export function buildAgentChainMessages(chainForModel: Message[], userMessage: Message): Message[] {
  const lastUser = [...chainForModel].reverse().find((m) => m.role === 'user');
  if (lastUser && lastUser.content === userMessage.content) return [lastUser];
  return [userMessage];
}
