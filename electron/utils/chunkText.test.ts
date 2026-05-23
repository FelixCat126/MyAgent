// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { chunkText } from './chunkText';

describe('chunkText（工作区索引文本切块）', () => {
  it('空字符串返回空数组', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('短文本仅一块', () => {
    const s = '只有一段。';
    expect(chunkText(s)).toEqual([s]);
  });

  it('按段落聚合：若两段相加未超上限，仍为一块', () => {
    const a = 'A'.repeat(100);
    const b = 'B'.repeat(100);
    const parts = chunkText(`${a}\n\n${b}`, 900, 100);
    expect(parts).toEqual([`${a}\n\n${b}`]);
  });

  it('段落超上限：按 max-overlap 步长切片', () => {
    const big = 'x'.repeat(500);
    const parts = chunkText(big, 200, 50);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts.every((p) => p.length <= 200)).toBe(true);
    expect(parts.join('').length).toBeGreaterThan(big.length - parts.length);
  });

  it('多段混合：超过单段上限的段独立切块；短段聚合', () => {
    const short1 = '短段一。';
    const huge = 'h'.repeat(450);
    const short2 = '短段二。';
    const parts = chunkText([short1, huge, short2].join('\n\n'), 200, 50);
    expect(parts[0]).toBe(short1);
    expect(parts.some((p) => p.startsWith('hhhh'))).toBe(true);
    expect(parts[parts.length - 1]).toBe(short2);
  });

  it('CRLF 归一化为 LF', () => {
    const parts = chunkText('line1\r\n\r\nline2');
    expect(parts).toEqual(['line1\n\nline2']);
  });
});
