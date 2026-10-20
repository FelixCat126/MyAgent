import type { Message, FileInfo } from '../types';
import { parseImageNumber } from './imageIntentPlanner';

export function resolveImageReferences(user: Message, history: Message[]): string[] {
  const paths = (files?: FileInfo[]) => (files ?? []).filter(f => f.type.startsWith('image/') && f.path).map(f => f.path);
  const attached = paths(user.files);
  if (attached.length) return attached;
  const text = user.content;
  /** 只认明确指代已有图片的说法；「保持简约风格」「code editor」等普通描述不能把历史图当参考图 */
  const pureEdit = /改成|换成/.test(text) && !/画|生成|绘制|创作|draw|generate|create/i.test(text);
  if (!pureEdit && !/上一[张组幅]|刚才(?:那|的|生成)|刚刚(?:那|的|生成)|原图|这张|那张|这些图|这组图|第[一二两三四五六七八九十\d]+张|参考(?:上|这|那|刚|原)|\b(?:previous|last) image\b|\bedit (?:the|this|that|last|previous) (?:image|picture|photo)\b/i.test(text)) return [];
  const group = [...history].reverse().map(m => paths(m.files)).find(p => p.length);
  if (!group) {
    if (pureEdit) return [];
    throw new Error('没有找到要修改的图片，请先上传图片或生成一张图片。');
  }
  const ordinal = text.match(/第([一二两三四五六七八九十\d]+)张/);
  if (ordinal) {
    const index = (parseImageNumber(ordinal[1]) ?? 0) - 1;
    if (!group[index]) throw new Error(`上一组只有 ${group.length} 张图片，请指定有效的图片序号。`);
    return [group[index]];
  }
  return /上一组|这些|这组|全部|所有/.test(text) ? group : [group[group.length - 1]];
}
