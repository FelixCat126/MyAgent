import type { Message } from '../types';

export interface ImageIntent {
  shouldGenerate: boolean;
  prompt: string;
  count?: number;
}

const ZH_DIGITS: Record<string, number> = {
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

const IMAGE_NOUN_RE =
  /图|图片|照片|海报|插画|头像|商品图|主图|形象|壁纸|展示图|模特图|成品图|image|picture|poster|avatar|photo/i;

const CREATE_RE = /画|绘制|生成|生|出|做|来|制作|设计|重新|再|继续|换|改|调整|generate|create|make/i;

export function inferImageCountFromText(text: string): number | undefined {
  const t = String(text || '');
  const digit = t.match(/(?:生成|生|出|给我|做|来|再|继续|重新|make|generate|create)?.{0,12}?(\d{1,2})\s*(?:张|个|幅|款|版|套|组|variants?|images?|options?)/i);
  if (digit) {
    const n = parseInt(digit[1], 10);
    if (Number.isFinite(n) && n > 1) return Math.min(12, n);
  }
  const zh = t.match(/(?:生成|生|出|给我|做|来|再|继续|重新)?.{0,12}?([一二两三四五六七八九十])\s*(?:张|个|幅|款|版|套|组)/);
  if (zh) {
    const n = ZH_DIGITS[zh[1]];
    if (n > 1) return Math.min(12, n);
  }
  const everyOne =
    /每(?:人|个|位|张|款).{0,12}(?:一张|1\s*张|一幅|1\s*幅|一版|1\s*版)|(?:每人|一人).{0,12}(?:一张|一幅|一个)|one\s+(?:image|picture|portrait)\s+(?:for|per)\s+(?:each|every)/i.test(t);
  const allItems =
    /(?:所有|全部|每个|每位).{0,16}(?:伙伴|角色|人物|船员|成员|款式|方案)|(?:伙伴|角色|人物|船员|成员|款式|方案).{0,16}(?:每人|每个|每位|各自|分别)/.test(t);
  if (everyOne || allItems) return 8;
  return undefined;
}

function looksLikeImageRequest(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;
  if (CREATE_RE.test(t) && IMAGE_NOUN_RE.test(t)) return true;
  if (/(?:多张|几张|一组|几版|几套|多套).{0,18}(?:不同|方案|款式|风格|动作|模特|展示)/.test(t)) return true;
  if (/(?:再|继续|重新|另|多).{0,12}(?:生成|生|出|做|来|换|改).{0,16}(?:\d+\s*张|几张|多张|一组|几版|几个|一些|variants?|images?)/i.test(t)) return true;
  return false;
}

function lastUserImageRequest(history: Message[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== 'user') continue;
    const c = (m.content || '').trim();
    if (looksLikeImageRequest(c)) return c;
  }
  return '';
}

function isRevisionRequest(text: string): boolean {
  return /(?:重新|再|继续|还是|按照|按|沿用|基于|之前|刚才|上次|同样|换|改|调整|不要|不是|而是|更|偏)/.test(text);
}

export function planImageIntent(input: {
  userText: string;
  historyBeforeUser: Message[];
  assistantText?: string;
  toolCallCount?: number;
}): ImageIntent {
  const userText = String(input.userText || '').trim();
  const assistantText = String(input.assistantText || '').trim();
  const combined = [userText, assistantText].filter(Boolean).join('\n');
  const count = inferImageCountFromText(combined);
  const explicitImage = looksLikeImageRequest(userText) || looksLikeImageRequest(assistantText);
  const hasToolCall = (input.toolCallCount ?? 0) > 0;

  if (!explicitImage && !hasToolCall) {
    return { shouldGenerate: false, prompt: userText, count };
  }

  const previous = isRevisionRequest(userText) ? lastUserImageRequest(input.historyBeforeUser) : '';
  const prompt =
    previous && previous !== userText
      ? `延续上一轮生图需求与风格：${previous}\n本轮修改要求：${userText}`
      : userText || assistantText;

  return {
    shouldGenerate: true,
    prompt,
    count,
  };
}
