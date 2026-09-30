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

  it('纯文件名/路径列表不算代码（避免误判）', () => {
    /** 多个路径行 + JSON-like 大括号（实际是路径里的 .json 后缀大括号）
     *  应不触发 looksLikeStandaloneCodeSnippet */
    const paths = [
      '/Users/Felix/project/src/utils/file.json',
      '/Users/Felix/project/src/components/Button.tsx',
      '/Users/Felix/project/src/types/index.d.ts',
      '/Users/Felix/project/package.json',
      '/Users/Felix/project/tsconfig.json',
    ].join('\n');
    expect(looksLikeStandaloneCodeSnippet(paths)).toBe(false);
  });

  it('混有关键字 + 路径也按代码（pathLike 阈值未达）', () => {
    const code = [
      "import fs from 'fs';",
      "import path from 'path';",
      "const root = path.join('/a', 'b.json');",
      "const buf = fs.readFileSync(root);",
      "console.log({ ok: true });",
    ].join('\n');
    expect(looksLikeStandaloneCodeSnippet(code)).toBe(true);
  });

  it('以 .json 后缀结尾但全文本叙述不算代码', () => {
    const desc =
      '请帮我打开位于 /Users/Felix/project/package.json 的文件，' +
      '修改 dependencies 中的 react 到 18.3.1 版本，然后运行 npm install 验证。';
    expect(looksLikeStandaloneCodeSnippet(desc)).toBe(false);
  });
});
