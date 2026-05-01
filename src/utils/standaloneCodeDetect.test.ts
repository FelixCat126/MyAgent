import { describe, expect, it } from 'vitest';
import { looksLikeStandaloneCodeSnippet } from './standaloneCodeDetect';

describe('looksLikeStandaloneCodeSnippet', () => {
  it('短文本或非代码不判定', () => {
    expect(looksLikeStandaloneCodeSnippet('你好')).toBe(false);
    expect(
      looksLikeStandaloneCodeSnippet(
        `# 标题\n这是一段很长很长很长很长很长的说明文案，不包含明显的代码标点与关键字，只是啰嗦了一点再啰嗦一点。\n再继续写一些内容凑够长度阈值。`
      )
    ).toBe(false);
  });

  it('多行含关键字与标点时判定为代码块', () => {
    const code = `
function sum(a: number, b: number): number {
  const x = a + b;
  if (x > 0) {
    console.log({ result: x });
  }
  return x;
}`;
    expect(looksLikeStandaloneCodeSnippet(code)).toBe(true);
  });

  it('已有 Markdown 围栏时不重复走整块代码气泡', () => {
    expect(looksLikeStandaloneCodeSnippet('```ts\nconst a = 1;\n```')).toBe(false);
  });
});
