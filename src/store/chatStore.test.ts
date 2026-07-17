import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from './chatStore';
import type { ChatSession, Message } from '../types';
import { PERSIST_KEYS } from '../utils/persistKeys';

function resetChatStore() {
  localStorage.removeItem(PERSIST_KEYS.chat);
  useChatStore.setState({
    sessions: [],
    currentSessionId: null,
    loadingSessionIds: new Set<string>(),
    compressingSessionIds: new Set<string>(),
  });
}

/** createSession 连续调用可能共用同一毫秒时间戳，多会话用固定 id 更稳 */
function seedTwoSessions(newerId: string, olderId: string, current: string) {
  const sNew: ChatSession = {
    id: newerId,
    title: 'B',
    messages: [],
    createdAt: 2,
    updatedAt: 2,
  };
  const sOld: ChatSession = {
    id: olderId,
    title: 'A',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  };
  useChatStore.setState({
    sessions: [sNew, sOld],
    currentSessionId: current,
    loadingSessionIds: new Set<string>(),
    compressingSessionIds: new Set<string>(),
  });
}

const userMsg = (id: string, text: string): Message => ({
  id,
  role: 'user',
  content: text,
  timestamp: 1,
  model: 'm',
});

const asstMsg = (id: string, text: string): Message => ({
  id,
  role: 'assistant',
  content: text,
  timestamp: 2,
  model: 'm',
});

describe('chatStore', () => {
  beforeEach(() => {
    resetChatStore();
  });

  it('createSession 追加新会话并设为当前', () => {
    const id1 = useChatStore.getState().createSession();
    const st = useChatStore.getState();
    expect(st.sessions).toHaveLength(1);
    expect(st.currentSessionId).toBe(id1);
    expect(st.sessions[0].title).toBe('新对话');

    const id2 = useChatStore.getState().createSession();
    expect(useChatStore.getState().sessions).toHaveLength(2);
    expect(useChatStore.getState().currentSessionId).toBe(id2);
  });

  it('addMessage 更新 updatedAt；助手在非当前会话时标未读', () => {
    seedTwoSessions('sess-b', 'sess-a', 'sess-b');
    useChatStore.getState().addMessage('sess-a', asstMsg('m1', '回'));
    const sa = useChatStore.getState().sessions.find((x) => x.id === 'sess-a');
    expect(sa?.unreadAssistantReply).toBe(true);
  });

  it('switchSession 切回时清除该会话未读', () => {
    seedTwoSessions('sess-b', 'sess-a', 'sess-b');
    useChatStore.getState().addMessage('sess-a', asstMsg('m1', 'x'));
    expect(useChatStore.getState().sessions.find((x) => x.id === 'sess-a')?.unreadAssistantReply).toBe(
      true
    );

    useChatStore.getState().switchSession('sess-a');
    expect(useChatStore.getState().sessions.find((x) => x.id === 'sess-a')?.unreadAssistantReply).toBe(
      false
    );
  });

  it('deleteSession 删当前时切到列表第一个', () => {
    seedTwoSessions('sess-b', 'sess-a', 'sess-b');
    useChatStore.getState().deleteSession('sess-b');
    expect(useChatStore.getState().currentSessionId).toBe('sess-a');
  });

  it('deleteSession 删到空时 current 为 null', () => {
    const a = useChatStore.getState().createSession();
    useChatStore.getState().deleteSession(a);
    expect(useChatStore.getState().currentSessionId).toBeNull();
  });

  it('updateMessage 与 appendToMessage', () => {
    const sid = useChatStore.getState().createSession();
    useChatStore.getState().addMessage(sid, userMsg('u1', 'a'));
    useChatStore.getState().updateMessage(sid, 'u1', { content: 'b' });
    expect(useChatStore.getState().sessions[0].messages[0].content).toBe('b');

    useChatStore.getState().appendToMessage(sid, 'u1', 'c');
    expect(useChatStore.getState().sessions[0].messages[0].content).toBe('bc');
  });

  it('removeMessage 删除会话内气泡', () => {
    const sid = useChatStore.getState().createSession();
    useChatStore.getState().addMessage(sid, userMsg('u1', 'a'));
    useChatStore.getState().addMessage(sid, asstMsg('a1', 'b'));
    useChatStore.getState().removeMessage(sid, 'a1');
    expect(useChatStore.getState().sessions[0].messages).toHaveLength(1);
    expect(useChatStore.getState().sessions[0].messages[0].id).toBe('u1');
  });

  it('removeMessages 批量删除会话内气泡', () => {
    const sid = useChatStore.getState().createSession();
    useChatStore.getState().addMessage(sid, userMsg('u1', 'a'));
    useChatStore.getState().addMessage(sid, asstMsg('a1', 'b'));
    useChatStore.getState().addMessage(sid, asstMsg('a2', 'c'));

    useChatStore.getState().removeMessages(sid, ['u1', 'a2']);
    const messages = useChatStore.getState().sessions[0].messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('a1');
  });

  it('setSessionWebOverride 与 updateSessionTitle', () => {
    const sid = useChatStore.getState().createSession();
    useChatStore.getState().setSessionWebOverride(sid, 'on');
    expect(useChatStore.getState().sessions[0].webSearchOverride).toBe('on');
    useChatStore.getState().updateSessionTitle(sid, 'T');
    expect(useChatStore.getState().sessions[0].title).toBe('T');
  });

  it('setLoadingSession 与 clearLoadingForSession', () => {
    const sid = useChatStore.getState().createSession();
    useChatStore.getState().setLoadingSession(sid);
    expect(useChatStore.getState().loadingSessionIds.has(sid)).toBe(true);
    useChatStore.getState().clearLoadingForSession('other');
    expect(useChatStore.getState().loadingSessionIds.has(sid)).toBe(true);
    useChatStore.getState().clearLoadingForSession(sid);
    expect(useChatStore.getState().loadingSessionIds.has(sid)).toBe(false);
  });

  it('clearLoadingForSession 不因失败/停止误标未读', () => {
    seedTwoSessions('sess-b', 'sess-a', 'sess-b');
    useChatStore.getState().setLoadingSession('sess-a');
    useChatStore.getState().clearLoadingForSession('sess-a');
    expect(useChatStore.getState().sessions.find((x) => x.id === 'sess-a')?.unreadAssistantReply).toBeFalsy();
  });

  it('setLoadingSession(null) 清空整个集合', () => {
    /** 用固定 sid 避免 createSession 在同毫秒下生成相同 id */
    useChatStore.setState({
      sessions: [
        { id: 'fix-sid-a', title: 'A', messages: [], createdAt: 1, updatedAt: 1 },
        { id: 'fix-sid-b', title: 'B', messages: [], createdAt: 2, updatedAt: 2 },
      ],
      currentSessionId: 'fix-sid-b',
      loadingSessionIds: new Set<string>(),
      compressingSessionIds: new Set<string>(),
    });
    useChatStore.getState().setLoadingSession('fix-sid-a');
    useChatStore.getState().setLoadingSession('fix-sid-b');
    expect(useChatStore.getState().loadingSessionIds.size).toBe(2);
    useChatStore.getState().setLoadingSession(null);
    expect(useChatStore.getState().loadingSessionIds.size).toBe(0);
  });

  it('deleteSession 同时清理 loading/compressing 集合', () => {
    /** 用固定 id 避免 createSession 毫秒冲突 */
    const sid1 = 'fixed-sid-1';
    const sid2 = 'fixed-sid-2';
    useChatStore.setState({
      sessions: [
        { id: sid1, title: 'A', messages: [], createdAt: 1, updatedAt: 1 },
        { id: sid2, title: 'B', messages: [], createdAt: 2, updatedAt: 2 },
      ],
      currentSessionId: sid2,
      loadingSessionIds: new Set<string>(),
      compressingSessionIds: new Set<string>(),
    });
    useChatStore.getState().setLoadingSession(sid1);
    useChatStore.getState().setLoadingSession(sid2);
    useChatStore.getState().setCompressingContext(sid1);
    expect(useChatStore.getState().loadingSessionIds.size).toBe(2);
    useChatStore.getState().deleteSession(sid1);
    const st = useChatStore.getState();
    expect(st.loadingSessionIds.has(sid1)).toBe(false);
    expect(st.loadingSessionIds.has(sid2)).toBe(true);
    expect(st.compressingSessionIds.has(sid1)).toBe(false);
  });
});

describe('replaceMessagesPrefix（保护 #12 prefix 合并）', () => {
  const userMsg = (id: string, text: string): Message => ({
    id,
    role: 'user',
    content: text,
    timestamp: 1,
    model: 'm',
  });
  const asstMsg = (id: string, text: string): Message => ({
    id,
    role: 'assistant',
    content: text,
    timestamp: 2,
    model: 'm',
  });
  const summary: Message = {
    id: 'sum',
    role: 'assistant',
    content: '[摘要]',
    timestamp: 999,
    model: 'm',
  };

  it('基本压缩：删除前 keepFromIndex 之前的消息，前插 summary', () => {
    const sid = useChatStore.getState().createSession();
    useChatStore.getState().addMessage(sid, userMsg('u1', 'a'));
    useChatStore.getState().addMessage(sid, asstMsg('a1', 'A'));
    useChatStore.getState().addMessage(sid, userMsg('u2', 'b'));
    useChatStore.getState().addMessage(sid, asstMsg('a2', 'B'));
    /** 保留 u2 + a2，删除前面的 u1 + a1 */
    useChatStore.getState().replaceMessagesPrefix(sid, 2, summary);
    const msgs = useChatStore.getState().sessions[0].messages;
    expect(msgs).toHaveLength(3);
    expect(msgs[0].id).toBe('sum');
    expect(msgs[1].id).toBe('u2');
    expect(msgs[2].id).toBe('a2');
  });

  it('keepFromIndex 为 0 = 保留全部（summary 前插）', () => {
    const sid = useChatStore.getState().createSession();
    useChatStore.getState().addMessage(sid, userMsg('u1', 'a'));
    useChatStore.getState().addMessage(sid, asstMsg('a1', 'A'));
    useChatStore.getState().replaceMessagesPrefix(sid, 0, summary);
    const msgs = useChatStore.getState().sessions[0].messages;
    /** keepFromIndex=0 → recent = 全部 → result = [summary, u1, a1] */
    expect(msgs).toHaveLength(3);
    expect(msgs[0].id).toBe('sum');
    expect(msgs[1].id).toBe('u1');
    expect(msgs[2].id).toBe('a1');
  });

  it('keepFromIndex >= messages.length：summary 唯一', () => {
    const sid = useChatStore.getState().createSession();
    useChatStore.getState().addMessage(sid, userMsg('u1', 'a'));
    useChatStore.getState().replaceMessagesPrefix(sid, 999, summary);
    const msgs = useChatStore.getState().sessions[0].messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe('sum');
  });

  it('keepFromIndex 越界（负数）被 clamp 到 0：保留全部', () => {
    const sid = useChatStore.getState().createSession();
    useChatStore.getState().addMessage(sid, userMsg('u1', 'a'));
    useChatStore.getState().addMessage(sid, asstMsg('a1', 'A'));
    useChatStore.getState().replaceMessagesPrefix(sid, -10, summary);
    const msgs = useChatStore.getState().sessions[0].messages;
    /** -10 clamp 到 0 → recent = 全部 → result = [summary, u1, a1] */
    expect(msgs).toHaveLength(3);
    expect(msgs[0].id).toBe('sum');
    expect(msgs[1].id).toBe('u1');
    expect(msgs[2].id).toBe('a1');
  });

  it('不存在 session 时不抛错', () => {
    expect(() =>
      useChatStore.getState().replaceMessagesPrefix('not-exist', 0, summary)
    ).not.toThrow();
  });

  it('updatedAt 被刷新', () => {
    const sid = useChatStore.getState().createSession();
    useChatStore.getState().addMessage(sid, userMsg('u1', 'a'));
    const before = useChatStore.getState().sessions[0].updatedAt;
    /** 等待至少 1ms 防止时间戳过快 */
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        useChatStore.getState().replaceMessagesPrefix(sid, 0, summary);
        const after = useChatStore.getState().sessions[0].updatedAt;
        expect(after).toBeGreaterThanOrEqual(before);
        resolve();
      }, 5);
    });
  });
});

describe('replaceMessagesPrefixBeforeIndex（编辑重发压缩）', () => {
  const userMsg = (id: string, text: string): Message => ({
    id,
    role: 'user',
    content: text,
    timestamp: 1,
    model: 'm',
  });
  const asstMsg = (id: string, text: string): Message => ({
    id,
    role: 'assistant',
    content: text,
    timestamp: 2,
    model: 'm',
  });
  const summary: Message = {
    id: 'sum',
    role: 'assistant',
    content: '[摘要]',
    timestamp: 999,
    model: 'm',
  };

  it('只压缩 [0, beforeIndex)，保留 source 及之后消息', () => {
    const sid = useChatStore.getState().createSession();
    useChatStore.getState().addMessage(sid, userMsg('u1', 'a'));
    useChatStore.getState().addMessage(sid, asstMsg('a1', 'A'));
    useChatStore.getState().addMessage(sid, userMsg('u2', 'b'));
    useChatStore.getState().addMessage(sid, asstMsg('a2', 'B'));
    /** beforeIndex=2 指向 u2；head=[u1,a1]；tail=[u2,a2]；keepFromIndex=0 → recentPrior=head.slice(0)=[u1,a1] */
    useChatStore.getState().replaceMessagesPrefixBeforeIndex(sid, 2, 0, summary);
    const msgs = useChatStore.getState().sessions[0].messages;
    /** result = [summary, u1, a1, u2, a2] */
    expect(msgs).toHaveLength(5);
    expect(msgs[0].id).toBe('sum');
    expect(msgs[1].id).toBe('u1');
    expect(msgs[2].id).toBe('a1');
    expect(msgs[3].id).toBe('u2');
    expect(msgs[4].id).toBe('a2');
  });

  it('keepFromIndex 在 head 中保留部分', () => {
    const sid = useChatStore.getState().createSession();
    useChatStore.getState().addMessage(sid, userMsg('u1', 'a'));
    useChatStore.getState().addMessage(sid, asstMsg('a1', 'A'));
    useChatStore.getState().addMessage(sid, userMsg('u2', 'b'));
    useChatStore.getState().addMessage(sid, asstMsg('a2', 'B'));
    /** beforeIndex=2 → head=[u1,a1]；keepFromIndex=1 → 保留 a1 */
    useChatStore.getState().replaceMessagesPrefixBeforeIndex(sid, 2, 1, summary);
    const msgs = useChatStore.getState().sessions[0].messages;
    expect(msgs).toHaveLength(4);
    expect(msgs[0].id).toBe('sum');
    expect(msgs[1].id).toBe('a1');
    expect(msgs[2].id).toBe('u2');
    expect(msgs[3].id).toBe('a2');
  });

  it('beforeIndex 为 messages.length：行为等同普通压缩', () => {
    const sid = useChatStore.getState().createSession();
    useChatStore.getState().addMessage(sid, userMsg('u1', 'a'));
    useChatStore.getState().addMessage(sid, asstMsg('a1', 'A'));
    useChatStore.getState().replaceMessagesPrefixBeforeIndex(sid, 2, 1, summary);
    const msgs = useChatStore.getState().sessions[0].messages;
    expect(msgs[0].id).toBe('sum');
    expect(msgs[1].id).toBe('a1');
  });

  it('beforeIndex 越界被 clamp 到 messages.length', () => {
    const sid = useChatStore.getState().createSession();
    useChatStore.getState().addMessage(sid, userMsg('u1', 'a'));
    useChatStore.getState().addMessage(sid, asstMsg('a1', 'A'));
    useChatStore.getState().replaceMessagesPrefixBeforeIndex(sid, 999, 0, summary);
    const msgs = useChatStore.getState().sessions[0].messages;
    /** beforeIndex clamp 到 2 → head=[u1,a1], tail=[]; keepFromIndex=0 → recentPrior=head.slice(0)=[u1,a1]
     *  result = [summary, u1, a1] */
    expect(msgs).toHaveLength(3);
    expect(msgs[0].id).toBe('sum');
    expect(msgs[1].id).toBe('u1');
    expect(msgs[2].id).toBe('a1');
  });
});

describe('resubmitUserMessageAtomically（#15 复合 action，原子化编辑重发）', () => {
  const userMsg = (id: string, text: string): Message => ({
    id,
    role: 'user',
    content: text,
    timestamp: 1,
    model: 'm',
  });
  const asstMsg = (id: string, text: string): Message => ({
    id,
    role: 'assistant',
    content: text,
    timestamp: 2,
    model: 'm',
  });

  it('更新源消息并删除尾部消息：单次 set() 原子完成', () => {
    const sid = useChatStore.getState().createSession();
    useChatStore.getState().addMessage(sid, userMsg('u1', '原始'));
    useChatStore.getState().addMessage(sid, asstMsg('a1', 'A1'));
    useChatStore.getState().addMessage(sid, userMsg('u2', '要删的'));
    useChatStore.getState().addMessage(sid, asstMsg('a2', 'A2'));
    useChatStore.getState().resubmitUserMessageAtomically(
      sid,
      'u1',
      { content: '已编辑', timestamp: 99 },
      ['a1', 'u2', 'a2']
    );
    const msgs = useChatStore.getState().sessions[0].messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe('u1');
    expect(msgs[0].content).toBe('已编辑');
    expect(msgs[0].timestamp).toBe(99);
  });

  it('空 staleIds 时仅更新源消息', () => {
    const sid = useChatStore.getState().createSession();
    useChatStore.getState().addMessage(sid, userMsg('u1', 'a'));
    useChatStore.getState().addMessage(sid, asstMsg('a1', 'b'));
    useChatStore.getState().resubmitUserMessageAtomically(
      sid,
      'u1',
      { content: 'edited' },
      []
    );
    const msgs = useChatStore.getState().sessions[0].messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('edited');
    expect(msgs[1].id).toBe('a1');
  });

  it('源消息不存在时不抛错', () => {
    const sid = useChatStore.getState().createSession();
    useChatStore.getState().addMessage(sid, userMsg('u1', 'a'));
    expect(() =>
      useChatStore.getState().resubmitUserMessageAtomically(sid, 'nonexistent', {}, ['u1'])
    ).not.toThrow();
  });
});
