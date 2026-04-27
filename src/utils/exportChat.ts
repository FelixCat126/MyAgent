import { ChatSession } from '../types';

export function sessionToMarkdown(session: ChatSession): string {
  const lines: string[] = [
    `# ${session.title}`,
    ``,
    `> 导出时间: ${new Date().toLocaleString('zh-CN')}`,
    ``,
  ];
  for (const m of session.messages) {
    const who =
      m.role === 'user' ? '**用户**' : m.role === 'assistant' ? '**助手**' : '**系统**';
    lines.push(`### ${who}`, '', m.content, '');
  }
  return lines.join('\n');
}

export function sessionToHtml(session: ChatSession): string {
  const body = session.messages
    .map(
      (m) =>
        `<section class="m"><h3>${m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '系统'}</h3><pre>${escapeHtml(
          m.content
        )}</pre></section>`
    )
    .join('\n');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${escapeHtml(
    session.title
  )}</title><style>body{font-family:system-ui;max-width:800px;margin:2rem auto}pre{white-space:pre-wrap}</style></head><body><h1>${escapeHtml(
    session.title
  )}</h1>${body}</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
