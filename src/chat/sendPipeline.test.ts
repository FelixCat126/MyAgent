import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '../store/chatStore';
import type { Message, ModelConfig } from '../types';
import {
  tryClaimSessionSend,
  addFullTextBypassIfNeeded,
  resolveInjectExtras,
} from './sendPipeline';
import { resubmitEditedUserMessage } from './resubmitEditedUserMessage';

function msg(role: Message['role'], content: string, id: string): Message {
  return { id, role, content, timestamp: Date.now(), model: 't' };
}

const fakeModel = {
  id: 'm1',
  name: 'test',
  provider: 'openai',
  apiUrl: 'https://example.com/v1',
  apiKey: '',
  modelName: 'gpt-test',
  maxTokens: 1024,
} as ModelConfig;

describe('sendPipeline', () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: [
        {
          id: 's1',
          title: 't',
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      currentSessionId: 's1',
      loadingSessionIds: new Set<string>(),
      loadingSessionIds: new Set<string>(),
      compressingSessionIds: new Set<string>(),
      compressingSessionIds: new Set<string>(),
    });
  });

  it('tryClaimSessionSend 占坑成功后再次占用失败', () => {
    expect(tryClaimSessionSend('s1')).toBe(true);
    expect(useChatStore.getState().isLoadingSession('s1')).toBe(true);
    expect(tryClaimSessionSend('s1')).toBe(false);
  });

  it('tryClaimSessionSend 在 compressing 时拒绝', () => {
    useChatStore.getState().setCompressingContext('s1');
    expect(tryClaimSessionSend('s1')).toBe(false);
  });

  it('addFullTextBypassIfNeeded 普通文本不绕过', () => {
    expect(
      addFullTextBypassIfNeeded({
        sessionId: 's1',
        modelName: 'm',
        textContent: '你好',
        hasAttachments: false,
      })
    ).toBe(false);
  });

  it('resolveInjectExtras 无工作区时 rag/workspace 为 false', () => {
    const extras = resolveInjectExtras({ webEnabled: true });
    expect(extras.webEnabled).toBe(true);
    expect(extras.ragLikely).toBe(false);
    expect(extras.workspaceLikely).toBe(false);
  });
});

describe('resubmitEditedUserMessage', () => {
  beforeEach(() => {
    const messages = [
      msg('user', '第一问', 'u1'),
      msg('assistant', '答1', 'a1'),
      msg('user', '第二问', 'u2'),
      msg('assistant', '答2', 'a2'),
    ];
    useChatStore.setState({
      sessions: [
        {
          id: 's1',
          title: 't',
          messages,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      currentSessionId: 's1',
      loadingSessionIds: new Set<string>(),
      loadingSessionIds: new Set<string>(),
      compressingSessionIds: new Set<string>(),
      compressingSessionIds: new Set<string>(),
    });
  });

  it('空内容返回 empty', async () => {
    const r = await resubmitEditedUserMessage({
      sessionId: 's1',
      messageId: 'u2',
      textContent: '   ',
      model: fakeModel,
      locale: 'zh',
      summaryTitle: '【上下文摘要】',
      webEnabled: false,
      runModelReply: vi.fn(),
    });
    expect(r).toEqual({ ok: false, reason: 'empty' });
  });

  it('非 user 消息返回 not-user', async () => {
    const r = await resubmitEditedUserMessage({
      sessionId: 's1',
      messageId: 'a1',
      textContent: '改',
      model: fakeModel,
      locale: 'zh',
      summaryTitle: '【上下文摘要】',
      webEnabled: false,
      runModelReply: vi.fn(),
    });
    expect(r).toEqual({ ok: false, reason: 'not-user' });
  });

  it('编辑重发更新内容、删除尾部并调用 runModelReply', async () => {
    const runModelReply = vi.fn().mockResolvedValue(undefined);
    const r = await resubmitEditedUserMessage({
      sessionId: 's1',
      messageId: 'u2',
      textContent: '第二问改写',
      model: fakeModel,
      locale: 'zh',
      summaryTitle: '【上下文摘要】',
      webEnabled: false,
      runModelReply,
    });
    expect(r).toEqual({ ok: true });
    const sess = useChatStore.getState().sessions.find((s) => s.id === 's1')!;
    expect(sess.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2']);
    expect(sess.messages.find((m) => m.id === 'u2')?.content).toBe('第二问改写');
    expect(runModelReply).toHaveBeenCalledTimes(1);
    const [, prior, userMsg] = runModelReply.mock.calls[0];
    expect(prior.map((m: Message) => m.id)).toEqual(['u1', 'a1']);
    expect(userMsg.content).toBe('第二问改写');
  });

  it('会话忙碌时返回 busy', async () => {
    tryClaimSessionSend('s1');
    const r = await resubmitEditedUserMessage({
      sessionId: 's1',
      messageId: 'u2',
      textContent: '改',
      model: fakeModel,
      locale: 'zh',
      summaryTitle: '【上下文摘要】',
      webEnabled: false,
      runModelReply: vi.fn(),
    });
    expect(r).toEqual({ ok: false, reason: 'busy' });
  });
});
