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
    lines.push(`### ${who}`, '');
    const reasoning = (m.reasoning ?? '').trim();
    if (m.role === 'assistant' && reasoning) {
      lines.push('*思考过程*', '', '```text', reasoning, '```', '');
    }
    lines.push(m.content, '');
  }
  return lines.join('\n');
}

export function sessionToHtml(session: ChatSession): string {
  const body = session.messages
    .map((m) => {
      const who = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '系统';
      const reasoning = (m.reasoning ?? '').trim();
      const reasoningBlock =
        m.role === 'assistant' && reasoning
          ? `<aside class="r"><strong>思考过程</strong><pre>${escapeHtml(reasoning)}</pre></aside>`
          : '';
      return `<section class="m"><h3>${who}</h3>${reasoningBlock}<pre>${escapeHtml(
        m.content
      )}</pre></section>`;
    })
    .join('\n');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${escapeHtml(
    session.title
  )}</title><style>body{font-family:system-ui;max-width:800px;margin:2rem auto}pre{white-space:pre-wrap}aside.r{margin:.75rem 0;padding:.5rem .75rem;border-left:3px solid #d97706;background:#fffbeb;color:#78350f}aside.r strong{display:block;margin-bottom:.35rem;font-size:.9em}</style></head><body><h1>${escapeHtml(
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
