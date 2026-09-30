import type { Message } from '../types';
import { looksLikeLocalImageFindRequest } from '../agent/localFileIntent';

export interface ImageIntent {
  shouldGenerate: boolean;
  prompt: string;
  count?: number;
  inheritStyle?: boolean;
  needsCount?: boolean;
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
  /(?:沿用|保持|延续|参考|基于|按照|按|同样|同风格|一致|这张|这些图片|上一张|上一组|上次|之前|刚才|刚刚|原图|那张|那组|same\s+style|keep\s+style|based\s+on|previous|last)/i;
const NON_IMAGE_OUTPUT_RE =
  /(?:表格|表单|清单|列表|大纲|文档|文本|文字|代码|公式|JSON|Markdown|Excel|CSV|Word|PPT|思维导图|流程图|mermaid|解释|分析|总结|翻译|润色|改写|提取|归纳)/i;
const IMAGE_NEGATION_RE = /(?:不是|不要|无需|不用|别|不需要|禁止|停止)(?:再)?(?:生图|绘图|画图|出图|生成图片|生成图像)(?!上的|中的)|(?:不是|不要|不需要)(?:图片|图像|照片)(?=[，。！!？?\s]|$)/i;
const VISUAL_OUTPUT_RE = /(?:展示|视觉|画面|构图|镜头|风格|款式|动作|模特|主体|背景|成品|素材|物料|variant|visual)/i;
const PER_ITEM_RE =
  /每(?:人|个|位|张|款|件|套|种|项).{0,12}(?:一张|1\s*张|一幅|1\s*幅|一版|1\s*版)|(?:每人|一人|各自|分别).{0,12}(?:一张|一幅|一个)|one\s+(?:image|picture|portrait)\s+(?:for|per)\s+(?:each|every)/i;
const GROUP_SCOPE_RE =
  /(?:所有|全部|每个|每位|各个|各位).{0,16}(?:角色|人物|成员|对象|主体|款式|方案|版本|物料|素材|item|subject|character|person)|(?:角色|人物|成员|对象|主体|款式|方案|版本|物料|素材|item|subject|character|person).{0,16}(?:每人|每个|每位|各自|分别|逐个)/i;

export function parseImageNumber(raw: string): number | undefined {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === '十') return 10;
  if (raw.includes('十')) {
    const [tens, units] = raw.split('十');
    return (ZH_DIGITS[tens] || 1) * 10 + (ZH_DIGITS[units] || 0);
  }
  return ZH_DIGITS[raw];
}

export function inferImageCountFromText(text: string): number | undefined {
  // 张/幅明确表示图片数量；“3个人”“第二张”不代表输出数量。
  const t = String(text || '');
  if (PER_ITEM_RE.test(t)) return undefined;
  const match = t.match(/(?<![第\d一二两三四五六七八九十])([0-9]+|[一二两三四五六七八九十]+)\s*(?:张|幅|images?\b|pictures?\b)/i);
  if (!match) return undefined;
  const n = parseImageNumber(match[1]);
  return n && n > 0 ? n : undefined;
}

export function imageRequestIsDiscussion(text: string): boolean {
  if (/(?:do not|don't|no need to)\s+(?:generate|create|draw)/i.test(text) || IMAGE_NEGATION_RE.test(text)) return true;
  const discussion = /^(?:请|先|帮我|给我)?\s*(?:解释|讲解|分析|讨论|介绍|检查|how\s+(?:to|does)|explain)/i.test(text)
    || /(?:写|提供|给出|只要|只需).{0,18}(?:示例|代码|提示词|教程)/.test(text);
  const alsoGenerate = /(?:同时|并且|然后|再)(?:请|帮我|给我)?(?:生成|画|出图)/.test(text);
  return discussion && !alsoGenerate;
}

function textPrefersNonImageOutput(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;
  if (imageRequestIsDiscussion(t)) return true;
  return NON_IMAGE_OUTPUT_RE.test(t) && !IMAGE_NOUN_RE.test(t);
}

function looksLikeImageRequest(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;
  if (looksLikeLocalImageFindRequest(t)) return false;
  if (textPrefersNonImageOutput(t)) return false;
  if (CREATE_RE.test(t) && IMAGE_NOUN_RE.test(t)) return true;
  if (IMAGE_NOUN_RE.test(t) && (PER_ITEM_RE.test(t) || GROUP_SCOPE_RE.test(t))) return true;
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
  if (looksLikeLocalImageFindRequest(userText) || imageRequestIsDiscussion(userText)) {
    return { shouldGenerate: false, prompt: userText, count: undefined, inheritStyle: false };
  }
  const count = inferImageCountFromText(userText);
  const explicitImage = looksLikeImageRequest(userText);
  const hasToolCall = (input.toolCallCount ?? 0) > 0;
  const shouldInherit = explicitlyReferencesPreviousImage(userText);
  const previous = shouldInherit ? lastUserImageRequest(input.historyBeforeUser) : '';
  const hasImage = input.historyBeforeUser.some(m => m.files?.some(f => f.type.startsWith('image/')));
  const nonImageOutput = textPrefersNonImageOutput(userText);
  const revisionOfPreviousImage =
    (Boolean(previous) || hasImage) &&
    isRevisionRequest(userText) &&
    !nonImageOutput &&
    (shouldInherit || IMAGE_NOUN_RE.test(userText) ||
      count !== undefined ||
      (CREATE_RE.test(userText) && VISUAL_OUTPUT_RE.test(userText)) ||
      /(?:重新|再|继续).{0,12}(?:生成|生|出|做|来)/.test(userText));

  if (!hasToolCall && !explicitImage && !revisionOfPreviousImage) {
    return { shouldGenerate: false, prompt: userText, count, inheritStyle: false };
  }

  const prompt =
    previous && previous !== userText
      ? `根据本轮要求区分参考风格与编辑原图：更换主体时仅参考风格；局部编辑时保留原图未要求修改的内容。\n上一轮参考：${previous}\n本轮要求：${userText}`
      : userText || assistantText;

  return {
    shouldGenerate: true,
    needsCount: PER_ITEM_RE.test(userText),
    prompt,
    count,
    inheritStyle: shouldInherit && (Boolean(previous) || hasImage),
  };
}
