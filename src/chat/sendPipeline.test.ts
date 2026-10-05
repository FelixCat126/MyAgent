import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '../store/chatStore';
import { useMemoryStore } from '../store/memoryStore';
import type { Message, ModelConfig } from '../types';
import {
  tryClaimSessionSend,
  addFullTextBypassIfNeeded,
  resolveInjectExtras,
  commitUserMessageAndReply,
} from './sendPipeline';
import { resubmitEditedUserMessage } from './resubmitEditedUserMessage';

vi.mock('../features/runtime/taskBridge', () => ({
  createSessionTask: vi.fn(async () => {}),
  saveSessionCheckpoint: vi.fn(async () => {}),
  finishSessionTask: vi.fn(async () => {}),
}));

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
      compressingSessionIds: new Set<string>(),
    });
  });

  it('tryClaimSessionSend 占坑成功后再次占用失败', () => {
    expect(tryClaimSessionSend('s1')).toBe(true);
    expect(useChatStore.getState().isLoadingSession('s1')).toBe(true);
    expect(tryClaimSessionSend('s1')).toBe(false);
  });

  it('不同会话也串行，防止同窗口模型流和快捷面板互相覆盖',()=>{useChatStore.getState().setLoadingSession('another');expect(tryClaimSessionSend('s1')).toBe(false);expect(useChatStore.getState().isLoadingSession('s1')).toBe(false);});

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

  it.each(['记住：我喜欢简洁回答', '忘掉全部记忆', '/remember I prefer concise replies'])('sends %s to the model without local memory changes or bypass', async textContent => {
    useMemoryStore.setState({ memories: [], candidateExtractionEnabled: true });
    useMemoryStore.getState().addMemory({ content: 'SENTINEL_RETIRED_MEMORY', scope: 'personal', alwaysApply: true });
    const memories = structuredClone(useMemoryStore.getState().memories);
    const runModelReply = vi.fn(async () => { useChatStore.getState().clearLoadingForSession('s1'); });
    expect(resolveInjectExtras({ webEnabled: false, sessionId: 's1', userText: textContent }).personalMaxChars).toBe(0);
    expect(tryClaimSessionSend('s1')).toBe(true);
    const result = await commitUserMessageAndReply({
      sessionId: 's1', textContent, model: fakeModel, locale: 'zh', summaryTitle: '【上下文摘要】',
      webEnabled: false, attachmentTitle: '附件', newSessionTitle: '新对话', runModelReply,
    });
    expect(result.bypassed).toBe(false);
    expect(runModelReply).toHaveBeenCalledWith('s1', [], expect.objectContaining({ role: 'user', content: textContent }), fakeModel);
    expect(useChatStore.getState().sessions[0].messages).toEqual([expect.objectContaining(result.userMessage)]);
    expect(useMemoryStore.getState().memories).toEqual(memories);
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

  it('resubmits an edited memory-shaped request through the model and preserves old memory records', async () => {
    useMemoryStore.setState({ memories: [], candidateExtractionEnabled: true });
    useMemoryStore.getState().addMemory({ content: 'SENTINEL_RETIRED_MEMORY', scope: 'personal', alwaysApply: true });
    const memories = structuredClone(useMemoryStore.getState().memories);
    const runModelReply = vi.fn(async () => { useChatStore.getState().clearLoadingForSession('s1'); });
    const result = await resubmitEditedUserMessage({
      sessionId: 's1', messageId: 'u2', textContent: '记住：我喜欢简洁回答', model: fakeModel,
      locale: 'zh', summaryTitle: '【上下文摘要】', webEnabled: false, runModelReply,
    });
    expect(result).toEqual({ ok: true });
    expect(runModelReply).toHaveBeenCalledWith('s1', expect.any(Array), expect.objectContaining({ id: 'u2', content: '记住：我喜欢简洁回答' }), fakeModel);
    expect(useMemoryStore.getState().memories).toEqual(memories);
    expect(useChatStore.getState().sessions[0].messages.some(message => message.model === '本地记忆')).toBe(false);
  });

  it('消息提交后立即通知界面退出编辑态，不等待模型回复结束', async () => {
    let finishReply: (() => void) | undefined;
    const runModelReply = vi.fn(
      () => new Promise<void>((resolve) => {
        finishReply = resolve;
      })
    );
    const onCommitted = vi.fn();

    const pending = resubmitEditedUserMessage({
      sessionId: 's1',
      messageId: 'u2',
      textContent: '立即变回气泡',
      model: fakeModel,
      locale: 'zh',
      summaryTitle: '【上下文摘要】',
      webEnabled: false,
      runModelReply,
      onCommitted,
    });

    await vi.waitFor(() => expect(onCommitted).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(runModelReply).toHaveBeenCalledOnce());
    expect(useChatStore.getState().sessions[0].messages.at(-1)?.content).toBe('立即变回气泡');

    finishReply?.();
    await expect(pending).resolves.toEqual({ ok: true });
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
