/**
 * 判断 Markdown 正文中是否包含类似 GFM 管道表格的结构（用于控制「导出表格」类按钮展示）
 */
export function markdownContainsPipeTable(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const lines = text.split(/\r?\n/);
  let pipeRows = 0;
  let hasSeparatorRow = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.includes('|')) continue;
    // 表格行通常以 | 开头且含多个单元格分隔
    if (/^\|.+\|$/.test(line) || (/^\|/.test(line) && line.split('|').length >= 3)) {
      pipeRows++;
    }
    // 分隔行：| --- | --- |
    if (/^\|[\s\-:|]+\|\s*$/.test(line) || /^\|[\s\-:|]+\|[\s\-:|]/.test(line)) {
      hasSeparatorRow = true;
    }
  }
  // 有典型分隔行 + 至少一行内容，或至少两行管道行（简易表）
  if (hasSeparatorRow && pipeRows >= 2) return true;
  if (pipeRows >= 3) return true;
  return false;
}
