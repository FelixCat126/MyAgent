import { describe, expect, it, vi } from 'vitest';
import type { Message, ModelConfig } from '../types';
import { ensureContextBeforeSend, type EnsureContextStoreApi } from './ensureContextBeforeSend';

function message(id: string, content: string): Message {
  return { id, role: Number(id) % 2 ? 'user' : 'assistant', content, timestamp: 1, model: 'test' };
}

const localModel: ModelConfig = {
  id: 'local', name: 'Local', provider: 'ollama', apiUrl: 'http://127.0.0.1:11434',
  modelName: 'local', isLocal: true, maxTokens: 4096, contextWindowTokens: 16_384,
};

describe('ensureContextBeforeSend', () => {
  it('临时注入预留量很大时，不对很短的聊天历史做无效压缩', async () => {
    const prior = [message('1', 'a'), message('2', 'b'), message('3', 'c'), message('4', 'd')];
    const setCompressingContext = vi.fn();
    const store: EnsureContextStoreApi = {
      setCompressingContext,
      clearCompressingForSession: vi.fn(),
      getSessionMessages: () => prior,
      replaceMessagesPrefix: vi.fn(),
      replaceMessagesPrefixBeforeIndex: vi.fn(),
    };

    const result = await ensureContextBeforeSend({
      sessionId: 's', priorMessages: prior, draftInput: '短问题', model: localModel,
      injectExtras: { workspaceLikely: true, workspaceMaxChars: 200_000 }, store,
    });

    expect(result.didCompress).toBe(false);
    expect(setCompressingContext).not.toHaveBeenCalled();
  });
});
