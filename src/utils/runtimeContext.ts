import type { Message } from '../types';

/** Temporary application context is rebuilt for each send, never restored as an old instruction. */
export function isGeneratedRuntimeContext(message: Message): boolean {
  if (message.role !== 'system') return false;
  return (message.model === 'myagent-personal-context' && message.id.startsWith('personal-ctx-'))
    || (message.model === 'workspace' && message.id.startsWith('wsctx-'))
    || (message.model === 'vector-rag' && message.id.startsWith('vecctx-'))
    || (message.model === 'agent-capability' && (message.id.startsWith('agent-sys-') || message.id === 'mcp-tools'));
}

/** Remove only excerpts tagged by our anchor generator; ordinary historical text stays intact. */
export function removeGeneratedContextExcerpts(content: string): string {
  return content.split('\n').filter((line) => !/^\[system (?:personal-ctx-|wsctx-|vecctx-|agent-sys-)[^\]\s]*\]\s/.test(line)).join('\n');
}

export function withoutGeneratedRuntimeContext(messages: Message[]): Message[] {
  return messages.flatMap((message) => {
    if (isGeneratedRuntimeContext(message)) return [];
    if (message.role !== 'assistant' || message.meta?.kind !== 'context-summary') return [message];
    const content = removeGeneratedContextExcerpts(message.content);
    return [content === message.content ? message : { ...message, content }];
  });
}

/** Keep durable tool/user progress, replacing only generated rules, roots and memory context. */
export function refreshRuntimeContext(saved: Message[], current: Message[]): Message[] {
  return [...current.filter(isGeneratedRuntimeContext), ...withoutGeneratedRuntimeContext(saved)];
}
