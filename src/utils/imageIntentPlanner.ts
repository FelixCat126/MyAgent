import type { Message } from '../types';
import { looksLikeLocalImageFindRequest } from '../agent/localFileIntent';

export interface ImageIntent {
  shouldGenerate: boolean;
  prompt: string;
  count?: number;
  inheritStyle?: boolean;
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

const CREATE_RE =
  /画|绘制|生成|生图|制作|设计|generate|create|make|出图|来一?(?:张|幅|组)|做一?(?:张|幅|组)|(?:给我|帮我)?(?:做|来)(?:一)?(?:张|幅|组)/i;
const REVISION_RE = /(?:重新|再|继续|还是|按照|按|沿用|基于|之前|刚才|上次|同样|换|改|调整|不要|不是|而是|更|偏)/;
const EXPLICIT_INHERIT_RE =
  /(?:沿用|保持|延续|参考|基于|按照|按|同样|同风格|一致|上一张|上一组|上次|之前|刚才|刚刚|原图|那张|那组|same\s+style|keep\s+style|based\s+on|previous|last)/i;
const NON_IMAGE_OUTPUT_RE =
  /(?:表格|表单|清单|列表|大纲|文档|文本|文字|代码|公式|JSON|Markdown|Excel|CSV|Word|PPT|思维导图|流程图|mermaid|解释|分析|总结|翻译|润色|改写|提取|归纳)/i;
const IMAGE_NEGATION_RE = /(?:不是|不要|无需|不用|别|不需要|禁止|停止).{0,8}(?:图|图片|照片|生图|生成图片|image|picture|photo)/i;
const VISUAL_OUTPUT_RE = /(?:展示|视觉|画面|构图|镜头|风格|款式|动作|模特|主体|背景|成品|素材|物料|variant|visual)/i;
const PER_ITEM_RE =
  /每(?:人|个|位|张|款|件|套|种|项).{0,12}(?:一张|1\s*张|一幅|1\s*幅|一版|1\s*版)|(?:每人|一人|各自|分别).{0,12}(?:一张|一幅|一个)|one\s+(?:image|picture|portrait)\s+(?:for|per)\s+(?:each|every)/i;
const GROUP_SCOPE_RE =
  /(?:所有|全部|每个|每位|各个|各位).{0,16}(?:角色|人物|成员|对象|主体|款式|方案|版本|物料|素材|item|subject|character|person)|(?:角色|人物|成员|对象|主体|款式|方案|版本|物料|素材|item|subject|character|person).{0,16}(?:每人|每个|每位|各自|分别|逐个)/i;

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
  if (PER_ITEM_RE.test(t) || GROUP_SCOPE_RE.test(t)) return 8;
  return undefined;
}

function textPrefersNonImageOutput(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;
  if (IMAGE_NEGATION_RE.test(t)) return true;
  return NON_IMAGE_OUTPUT_RE.test(t) && !IMAGE_NOUN_RE.test(t);
}

function looksLikeImageRequest(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;
  if (looksLikeLocalImageFindRequest(t)) return false;
  if (textPrefersNonImageOutput(t)) return false;
  if (CREATE_RE.test(t) && IMAGE_NOUN_RE.test(t)) return true;
  if (IMAGE_NOUN_RE.test(t) && inferImageCountFromText(t) && (PER_ITEM_RE.test(t) || GROUP_SCOPE_RE.test(t) || VISUAL_OUTPUT_RE.test(t))) return true;
  if (inferImageCountFromText(t) && VISUAL_OUTPUT_RE.test(t) && CREATE_RE.test(t)) return true;
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
  return REVISION_RE.test(text);
}

function explicitlyReferencesPreviousImage(text: string): boolean {
  return EXPLICIT_INHERIT_RE.test(text);
}

export function planImageIntent(input: {
  userText: string;
  historyBeforeUser: Message[];
  assistantText?: string;
  toolCallCount?: number;
}): ImageIntent {
  const userText = String(input.userText || '').trim();
  const assistantText = String(input.assistantText || '').trim();
  if (looksLikeLocalImageFindRequest(userText)) {
    return { shouldGenerate: false, prompt: userText, count: undefined, inheritStyle: false };
  }
  const combined = [userText, assistantText].filter(Boolean).join('\n');
  const count = inferImageCountFromText(combined);
  const explicitImage = looksLikeImageRequest(userText);
  const hasToolCall = (input.toolCallCount ?? 0) > 0;
  const shouldInherit = explicitlyReferencesPreviousImage(userText);
  const previous = shouldInherit ? lastUserImageRequest(input.historyBeforeUser) : '';
  const nonImageOutput = textPrefersNonImageOutput(userText);
  const revisionOfPreviousImage =
    Boolean(previous) &&
    isRevisionRequest(userText) &&
    !nonImageOutput &&
    (IMAGE_NOUN_RE.test(userText) ||
      count !== undefined ||
      (CREATE_RE.test(userText) && VISUAL_OUTPUT_RE.test(userText)) ||
      /(?:重新|再|继续).{0,12}(?:生成|生|出|做|来)/.test(userText));

  if (!hasToolCall && !explicitImage && !revisionOfPreviousImage) {
    return { shouldGenerate: false, prompt: userText, count, inheritStyle: false };
  }

  const prompt =
    previous && previous !== userText
      ? `仅参考上一轮图片的风格、画质、构图语言或系列一致性，不继承上一轮主体内容；本轮主体和画面内容以用户当前要求为准。\n上一轮参考：${previous}\n本轮要求：${userText}`
      : userText || assistantText;

  return {
    shouldGenerate: true,
    prompt,
    count,
    inheritStyle: Boolean(previous),
  };
}
