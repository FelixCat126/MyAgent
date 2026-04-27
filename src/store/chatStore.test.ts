import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from './chatStore';
import type { ChatSession, Message } from '../types';

function resetChatStore() {
  localStorage.removeItem('chat-storage');
  useChatStore.setState({
    sessions: [],
    currentSessionId: null,
    loadingSessionId: null,
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
    loadingSessionId: null,
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
    expect(useChatStore.getState().loadingSessionId).toBe(sid);
    useChatStore.getState().clearLoadingForSession('other');
    expect(useChatStore.getState().loadingSessionId).toBe(sid);
    useChatStore.getState().clearLoadingForSession(sid);
    expect(useChatStore.getState().loadingSessionId).toBeNull();
  });
});
