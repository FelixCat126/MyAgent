/**
 * 按关键词 / 显式前缀决定是否发起联网检索，避免每条消息都打搜索 API。
 */

/** 行首显式强制联网（检索时会去掉此前缀） */
const FORCE_PREFIX = /^\s*(\/web|\/联网|#联网)\s+/i;

/** 用户明确不要联网时整句跳过（省流量；勿用 \b，中文后词边界不稳定） */
const OPT_OUT = /^(不要联网|不联网|不用搜索|别搜索|无需联网)(?=\s|$)/i;

const KEYWORDS_CN = [
  '联网',
  '网络搜索',
  '网上搜',
  '搜一下',
  '搜一搜',
  '搜下',
  '搜索',
  '查询',
  '检索',
  '查一下',
  '查查',
  '帮我搜',
  '帮我查',
  '查查看',
  '百度',
  '谷歌',
  '必应',
  '维基',
  '官网',
  '官方网站',
  '新闻',
  '资讯',
  '最新消息',
  '热点',
  '最新',
  '今天',
  '今日',
  '近日',
  '昨天',
  '刚才',
  '实时',
  '股价',
  '股市',
  '汇率',
  '天气',
  '气温',
  '比分',
  '赛程',
  '对阵',
  '多少钱',
  '价格',
  '报价',
  '售价',
  '发行价',
  '什么时候发布',
  '何时上市',
  '上映时间',
  '火车票',
  '机票',
  '航班',
  '航班动态',
  '路况',
  '地震',
  '台风',
  '疫情通报',
];

/** 避免子串误伤（如 research 含 search） */
const KEYWORD_EN_RE =
  /\b(google|search|lookup|wikipedia|weather)\b|look\s+up|latest\s+news|news\s+about|stock\s+price|exchange\s+rate|official\s+site/i;

function hitKeywordCn(text: string): boolean {
  for (const k of KEYWORDS_CN) {
    if (text.includes(k)) return true;
  }
  return false;
}

function hitKeywordEn(text: string): boolean {
  return KEYWORD_EN_RE.test(text);
}

/**
 * @returns 若应发起检索则返回用于 API 的查询串（已截断、已去强制前缀）；否则返回 null
 */
export function getWebSearchQueryIfTriggered(rawContent: string): string | null {
  const trimmed = rawContent.trim();
  if (!trimmed || trimmed === '（附件）') return null;

  if (OPT_OUT.test(trimmed)) return null;

  if (FORCE_PREFIX.test(trimmed)) {
    const q = trimmed.replace(FORCE_PREFIX, '').trim();
    if (!q) return null;
    return q.slice(0, 800);
  }

  if (hitKeywordCn(trimmed) || hitKeywordEn(trimmed)) {
    let q = trimmed;
    // 去掉常见检索口令，提高 DuckDuckGo/Tavily 命中率（整句仍保留在聊天记录里）
    q = q
      .replace(
        /^(搜索|检索|查询|查一下|帮我搜|帮我搜索|帮我查|网上搜|网上搜索|搜一下|搜一搜|搜下|查查看|lookup|search\s+for|google\s+)\s*/i,
        ''
      )
      .trim();
    if (!q) q = trimmed;
    return q.slice(0, 800);
  }

  return null;
}
