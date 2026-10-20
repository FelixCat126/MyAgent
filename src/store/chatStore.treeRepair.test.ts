/** 回归：删除消息 / 上下文压缩后分支树仍连通，历史不从激活路径上消失 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from './chatStore';
import { getActiveMessages } from '../utils/branchTree';
import type { Message } from '../types';

const msg = (id: string, content = id): Message => ({
  id,
  role: id.startsWith('u') ? 'user' : 'assistant',
  content,
  timestamp: 1,
  model: 'm',
});
const summary: Message = { id: 'sum', role: 'assistant', content: '[摘要]', timestamp: 9, model: 'm' };

const activeIds = (sid: string) => {
  const s = useChatStore.getState().sessions.find((x) => x.id === sid)!;
  return getActiveMessages(s.messages, s.activeLeafId).map((m) => m.id);
};

const seed = (ids: string[]) => {
  const sid = useChatStore.getState().createSession();
  for (const id of ids) useChatStore.getState().addMessage(sid, msg(id));
  return sid;
};

describe('chatStore 分支树修补', () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: [],
      currentSessionId: null,
      loadingSessionIds: new Set(),
      compressingSessionIds: new Set(),
      activeLeafId: null,
    });
  });

  it('删除停止后的空气泡再发送，历史仍完整', () => {
    const sid = seed(['u1', 'a1', 'u2', 'a2']);
    useChatStore.getState().removeMessage(sid, 'a2');
    expect(useChatStore.getState().sessions[0].activeLeafId).toBe('u2');
    useChatStore.getState().addMessage(sid, msg('u3'));
    expect(activeIds(sid)).toEqual(['u1', 'a1', 'u2', 'u3']);
    expect(useChatStore.getState().activeLeafId).toBe('u3');
  });

  it('删除中间消息：子消息改挂到最近存活祖先', () => {
    const sid = seed(['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
    useChatStore.getState().removeMessages(sid, ['u2']);
    expect(activeIds(sid)).toEqual(['u1', 'a1', 'a2', 'u3', 'a3']);
    const a1 = useChatStore.getState().sessions[0].messages.find((m) => m.id === 'a1')!;
    expect(a1.children).toEqual(['a2']);
  });

  it('压缩后摘要留在激活路径上，后续发送仍带摘要', () => {
    const sid = seed(['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
    useChatStore.getState().replaceMessagesPrefix(sid, 2, summary);
    useChatStore.getState().addMessage(sid, msg('u4'));
    expect(activeIds(sid)).toEqual(['sum', 'u2', 'a2', 'u3', 'a3', 'u4']);
  });

  it('有分支时按激活路径下标压缩，并丢弃从被压缩前缀分叉的旧分支', () => {
    const sid = seed(['u1', 'a1']);
    const fork = useChatStore.getState().forkFromMessage(sid, 'u1');
    useChatStore.getState().updateMessage(sid, fork, { content: 'a1b' });
    for (const id of ['u2', 'a2', 'u3', 'a3']) useChatStore.getState().addMessage(sid, msg(id));
    /** 激活路径 [u1, fork, u2, a2, u3, a3]；保留 u2 起 */
    useChatStore.getState().replaceMessagesPrefix(sid, 2, summary);
    const flat = useChatStore.getState().sessions[0].messages.map((m) => m.id);
    expect(flat).toEqual(['sum', 'u2', 'a2', 'u3', 'a3']);
    expect(activeIds(sid)).toEqual(['sum', 'u2', 'a2', 'u3', 'a3']);
  });

  it('编辑重发压缩：只压缩源消息之前的路径段', () => {
    const sid = seed(['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
    useChatStore.getState().replaceMessagesPrefixBeforeIndex(sid, 4, 2, summary);
    expect(activeIds(sid)).toEqual(['sum', 'u2', 'a2', 'u3', 'a3']);
  });
});
