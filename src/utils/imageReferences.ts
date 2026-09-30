import type { Message, FileInfo } from '../types';
import { parseImageNumber } from './imageIntentPlanner';

export function resolveImageReferences(user: Message, history: Message[]): string[] {
  const paths = (files?: FileInfo[]) => (files ?? []).filter(f => f.type.startsWith('image/') && f.path).map(f => f.path);
  const attached = paths(user.files);
  if (attached.length) return attached;
  const text = user.content;
  if (!/上一|刚才|刚刚|原图|这张|那张|第二|第[一二三四五六七八九十\d]+张|保持|保留|改成|换成|参考|previous|last image|edit/i.test(text)) return [];
  const group = [...history].reverse().map(m => paths(m.files)).find(p => p.length);
  if (!group) throw new Error('没有找到要修改的图片，请先上传图片或生成一张图片。');
  const ordinal = text.match(/第([一二两三四五六七八九十\d]+)张/);
  if (ordinal) {
    const index = (parseImageNumber(ordinal[1]) ?? 0) - 1;
    if (!group[index]) throw new Error(`上一组只有 ${group.length} 张图片，请指定有效的图片序号。`);
    return [group[index]];
  }
  return /上一组|这些|这组|全部|所有/.test(text) ? group : [group[group.length - 1]];
}
