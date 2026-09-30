/** 整块助手回复是否更接近「源代码」而非自然语言Markdown（无前导说明时） */

const CODE_HINT =
  /\b(const|let|var|function|class|interface|type|async|await|import|export|from|namespace|extends|implements|throws|catch|finally|switch|enum|trait|pub|fn|mut|SELECT|WHERE|FROM|JOIN|CREATE\s+TABLE)\b/;
const CODE_SYNTAX = /[;{}]|=>|\?\?|[!=]==|::|\.forEach\(|\(.*\)\s*=>/;
/** 文件名/路径特征——含这些时即使命中 CODE_SYNTAX 也不算代码（避免 `/a/b.json` 这类被误判） */
const PATH_LINE = /(?:^|\s)(?:\.{0,2}\/)?[\w./-]+\.[a-zA-Z0-9]{1,5}(?::\d+)?(?=\s|$|,|;|\))/;
const MD_LINE_START = /^(\s*$|#{1,6}\s+|>\s+|[-*+]\s+|\d+\.\s+)/;

/** 判断是否适合用「整块代码编辑器」气泡展示而非通用 Markdown（仍可在 MessageItem 中加一层兜底） */
export function looksLikeStandaloneCodeSnippet(raw: string): boolean {
  const t = raw.trim();
  if (t.length < 48) return false;
  /** 已由 Markdown 代码围栏包裹时交由 MarkdownContent 的内联复制处理 */
  if (t.includes('```')) return false;
  /** 明显是短文或列表说明 */
  const lines = t.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 4) return false;

  const mdLike = lines.filter((l) => MD_LINE_START.test(l)).length;
  if (mdLike / lines.length > 0.35) return false;

  /** 文件名/路径型行：单独存在时不算代码（包含路径列表、引用、URL 段） */
  const pathLike = lines.filter((l) => PATH_LINE.test(l)).length;
  if (pathLike / lines.length > 0.3) return false;

  const codeish = lines.filter((l) => CODE_HINT.test(l) || CODE_SYNTAX.test(l)).length;
  if (codeish < 3) return false;
  return codeish >= Math.ceil(lines.length * 0.45);
}
