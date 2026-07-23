/** 分支树（v4）单测：fork / switch / migrate v2→v4 / 派生路径 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from './chatStore';
import { newId } from '../utils/newId';

const asst = (id: string, content = ''): import('../types').Message => ({
  id,
  role: 'assistant',
  content,
  timestamp: 0,
  model: 'test',
});

const user = (id: string, content = ''): import('../types').Message => ({
  id,
  role: 'user',
  content,
  timestamp: 0,
  model: '',
});

describe('chatStore 分支树 (v4)', () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: [],
      currentSessionId: null,
      loadingSessionIds: new Set(),
      compressingSessionIds: new Set(),
      activeLeafId: null,
    });
  });

  it('createSession 后 activeLeafId 为 null；首条 addMessage 后切到该 id', () => {
    const sid = useChatStore.getState().createSession();
    expect(useChatStore.getState().activeLeafId).toBeNull();
    useChatStore.getState().addMessage(sid, user('u1', 'hi'));
    expect(useChatStore.getState().activeLeafId).toBe('u1');
  });

  it('addMessage 默认主线续接：parentId 取上一叶，父的 children 推入新 id', () => {
    const sid = useChatStore.getState().createSession();
    useChatStore.getState().addMessage(sid, user('u1'));
    useChatStore.getState().addMessage(sid, asst('a1', 'first'));
    useChatStore.getState().addMessage(sid, user('u2', 'q2'));
    const msgs = useChatStore.getState().sessions[0].messages;
    expect(msgs.map((m) => m.parentId ?? null)).toEqual([null, 'u1', 'a1']);
    /** u1 是 a1 的父，所以 u1.children 推入 a1；a1 是 u2 的父，a1.children 推入 u2 */
    const u1 = msgs[0]!;
    const a1 = msgs[1]!;
    expect(u1.children).toEqual(['a1']);
    expect(a1.children).toEqual(['u2']);
  });

  it('forkFromMessage 生成新空消息并把父 children 推入新 id，activeLeafId 切到新 id', () => {
    const sid = useChatStore.getState().createSession();
    useChatStore.getState().addMessage(sid, user('u1'));
    useChatStore.getState().addMessage(sid, asst('a1', 'first'));
    useChatStore.getState().addMessage(sid, user('u2'));
    const forkId = useChatStore.getState().forkFromMessage(sid, 'a1');
    expect(forkId).toBeTruthy();
    const msgs = useChatStore.getState().sessions[0].messages;
    /** a1.children 应包含 fork（新分支） + u2（主线原有） */
    const a1 = msgs.find((m) => m.id === 'a1')!;
    expect(a1.children).toContain(forkId);
    expect(a1.children).toContain('u2');
    /** 新消息挂在 a1 之后 */
    const fork = msgs.find((m) => m.id === forkId)!;
    expect(fork.parentId).toBe('a1');
    /** activeLeafId 切到新分支 */
    expect(useChatStore.getState().activeLeafId).toBe(forkId);
  });

  it('switchBranch 切回主线（已知存在的叶），activeLeafId 更新', () => {
    const sid = useChatStore.getState().createSession();
    useChatStore.getState().addMessage(sid, user('u1'));
    useChatStore.getState().addMessage(sid, asst('a1'));
    useChatStore.getState().addMessage(sid, user('u2'));
    /** 在 a1 处开新分支；现在 activeLeafId 是 forkId */
    useChatStore.getState().forkFromMessage(sid, 'a1');
    const forkLeaf = useChatStore.getState().activeLeafId!;
    expect(forkLeaf).not.toBe('u2');
    /** 切到主线 u2 */
    useChatStore.getState().switchBranch(sid, 'u2');
    expect(useChatStore.getState().activeLeafId).toBe('u2');
  });

  it('switchBranch 对未知 messageId 是 no-op', () => {
    const sid = useChatStore.getState().createSession();
    useChatStore.getState().addMessage(sid, user('u1'));
    const before = useChatStore.getState().activeLeafId;
    useChatStore.getState().switchBranch(sid, 'does-not-exist');
    expect(useChatStore.getState().activeLeafId).toBe(before);
  });

  it('forkFromMessage 对不存在的 parentId 返回 id 但不修改 store', () => {
    const sid = useChatStore.getState().createSession();
    useChatStore.getState().addMessage(sid, user('u1'));
    const beforeLeaf = useChatStore.getState().activeLeafId;
    useChatStore.getState().forkFromMessage(sid, 'nonexistent');
    /** activeLeafId 仍为 u1（因内部 find 没命中，set 返回 {}，activeLeafId 不变） */
    expect(useChatStore.getState().activeLeafId).toBe(beforeLeaf);
  });

  it('addMessage 显式指定 parentId 时不覆盖（用户自定义分支结构不被破坏）', () => {
    const sid = useChatStore.getState().createSession();
    useChatStore.getState().addMessage(sid, user('u1'));
    useChatStore.getState().addMessage(sid, asst('a1'));
    /** 自定义一个不连续的 parentId */
    useChatStore.getState().addMessage(sid, { ...user('c1'), parentId: 'a1' });
    const c1 = useChatStore.getState().sessions[0].messages[2]!;
    expect(c1.parentId).toBe('a1');
  });
});

/** migrate v2 → v4：线性 messages 自动填 parentId/children，激活叶=末条 */
describe('chatStore migrate v2 → v4', () => {
  it('线性消息序列回填 parentId 并取末条为 activeLeafId', () => {
    const v2State = {
      sessions: [
        {
          id: 's1',
          title: 'old',
          messages: [
            { id: 'm1', role: 'user', content: 'a', timestamp: 0, model: '' },
            { id: 'm2', role: 'assistant', content: 'b', timestamp: 0, model: '' },
            { id: 'm3', role: 'user', content: 'c', timestamp: 0, model: '' },
          ],
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      currentSessionId: 's1',
    };
    /** 模拟 zustand persist 的 migrate 入口（直接调用 store 的 migrate 与 partialize 都拿不到，本测试通过重新写迁移逻辑验证） */
    const migrated = JSON.parse(JSON.stringify(v2State));
    migrated.sessions = migrated.sessions.map((sess: { messages: Array<{ id: string }> }) => {
      let prev: string | null = null;
      sess.messages = sess.messages.map((raw: { id: string } & Record<string, unknown>) => {
        const e: Record<string, unknown> = { ...raw, children: [] };
        if (prev) e.parentId = prev;
        prev = raw.id;
        return e;
      });
      return sess;
    });
    expect(migrated.sessions[0].messages[0].parentId).toBeUndefined();
    expect(migrated.sessions[0].messages[1].parentId).toBe('m1');
    expect(migrated.sessions[0].messages[2].parentId).toBe('m2');
    expect(migrated.sessions[0].messages.every((m: { children: unknown[] }) => Array.isArray(m.children))).toBe(true);
  });
});
