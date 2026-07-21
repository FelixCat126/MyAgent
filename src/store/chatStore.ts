import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ChatSession, Message } from '../types';
import { zustandPersistJson } from '../utils/zustandFileStorage';
import { PERSIST_KEYS } from '../utils/persistKeys';
import { newId } from '../utils/newId';
import { t } from '../i18n/ui';
import { useSettingStore } from './settingStore';

/**
 * 内部 helper：定位单个 session 并对其应用 fn，未命中时保持原引用。
 * 不自动更新时间戳、不处理 unread 语义，由调用方决定。
 *
 * 抽离目的：消除 chatStore 内部 13 处 `sessions.map(s => s.id === id ? update : s)` 重复模板。
 * 调用方必须保留原有 action 签名不变。
 */
function mapSession(
  sessions: ChatSession[],
  sessionId: string,
  fn: (session: ChatSession) => ChatSession
): ChatSession[] {
  return sessions.map((s) => (s.id === sessionId ? fn(s) : s));
}

type BusySetKey = 'loadingSessionIds' | 'compressingSessionIds';

/**
 * 忙态 Set 操作工厂：loading/compressing 两组 action 逻辑同构，仅字段名不同。
 * 注意：未读标记仅由 addMessage(assistant) 设置；remove 不打未读，
 * 避免失败/停止/上传中止时误亮「新」。
 */
function makeBusySetActions(
  key: BusySetKey,
  set: (fn: Partial<ChatStore> | ((state: ChatStore) => Partial<ChatStore>)) => void,
  get: () => ChatStore
) {
  return {
    /** null = 清空全部；非 null = 加入集合（支持多会话并发） */
    add(sessionId: string | null): void {
      if (sessionId === null) {
        set({ [key]: new Set() } as Partial<ChatStore>);
        return;
      }
      set((state) => {
        if (state[key].has(sessionId)) return {};
        const next = new Set(state[key]);
        next.add(sessionId);
        return { [key]: next } as Partial<ChatStore>;
      });
    },
    remove(sessionId: string): void {
      set((state) => {
        if (!state[key].has(sessionId)) return {};
        const next = new Set(state[key]);
        next.delete(sessionId);
        return { [key]: next } as Partial<ChatStore>;
      });
    },
    has(sessionId: string): boolean {
      return get()[key].has(sessionId);
    },
  };
}

/**
 * 内部 helper：消息列表前缀替换（纯函数，副作用 = 0）。
 *
 * 支持两种调用形态：
 * - 普通压缩：只传 keepFromIndex + summary → 把 [0, keepFromIndex) 替换为 [summary]，tail 从 keepFromIndex 起全保留
 * - 编辑重发压缩：传 beforeIndex + keepFromIndex + summary → 只压缩 [0, beforeIndex) 中的 [0, keepFromIndex)
 *   保留 tail（beforeIndex 起的全部，含 source message）
 *
 * 抽离目的：两个 action 的核心逻辑基本相同，统一实现便于维护，
 * 也让两个测试用例共享相同的下标处理代码。
 *
 * 注意：原有两个 action 均 clamp 越界到合法范围（不报错），本函数保持同样行为。
 */
function replaceMessagesPrefixCore(
  messages: Message[],
  keepFromIndex: number,
  summaryMessage: Message,
  beforeIndex?: number
): Message[] {
  if (beforeIndex === undefined) {
    /** 普通压缩：保留 [keepFromIndex, end) */
    const idx = Math.max(0, Math.min(keepFromIndex, messages.length));
    const recent = messages.slice(idx);
    return [summaryMessage, ...recent];
  }
  /** 编辑重发压缩：head = [0, beforeIndex)，tail = [beforeIndex, end)；从 head 中再裁 */
  const end = Math.max(0, Math.min(beforeIndex, messages.length));
  const head = messages.slice(0, end);
  const tail = messages.slice(end);
  const idx = Math.max(0, Math.min(keepFromIndex, head.length));
  const recentPrior = head.slice(idx);
  return [summaryMessage, ...recentPrior, ...tail];
}

interface ChatStore {
  sessions: ChatSession[];
  currentSessionId: string | null;
  /** 正在等待模型回复的会话 id 集合（支持多会话并发转圈） */
  loadingSessionIds: Set<string>;
  /** 正在自动压缩上下文的会话集合 */
  compressingSessionIds: Set<string>;

  // Actions
  createSession: () => string;
  switchSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  addMessage: (sessionId: string, message: Message) => void;
  /**
   * 原子编辑重发：updateMessage + removeMessages 在同一 set() 调用内完成。
   * 替代业务模块的 `getState().updateMessage(); getState().removeMessages();` 模式，
   * 消除中间状态窗口。原有 addMessage / updateMessage / removeMessages 行为完全保留。
   */
  resubmitUserMessageAtomically: (
    sessionId: string,
    messageId: string,
    patch: Partial<Message>,
    staleIds: string[]
  ) => void;
  removeMessage: (sessionId: string, messageId: string) => void;
  removeMessages: (sessionId: string, messageIds: string[]) => void;
  updateMessage: (sessionId: string, messageId: string, patch: Partial<Message>) => void;
  appendToMessage: (sessionId: string, messageId: string, chunk: string) => void;
  appendReasoningToMessage: (sessionId: string, messageId: string, chunk: string) => void;
  setSessionWebOverride: (sessionId: string, mode: 'default' | 'on' | 'off') => void;
  patchSessionAgentFileScope: (
    sessionId: string,
    patch: { extraRoots?: string[] }
  ) => void;
  updateSessionTitle: (sessionId: string, title: string) => void;
  /** null = 清空全部；非 null = 加入加载集合（支持多会话并发） */
  setLoadingSession: (sessionId: string | null) => void;
  clearLoadingForSession: (sessionId: string) => void;
  /** 判断指定会话是否正在加载 */
  isLoadingSession: (sessionId: string) => boolean;
  /** null = 清空全部压缩态；非 null = 将该会话加入压缩集合 */
  setCompressingContext: (sessionId: string | null) => void;
  clearCompressingForSession: (sessionId: string) => void;
  isCompressingSession: (sessionId: string) => boolean;
  /**
   * 删除 keepFromIndex 之前的消息，并在保留段前插入摘要消息。
   * keepFromIndex 为压缩前的下标（相对于替换前的 messages）。
   */
  replaceMessagesPrefix: (
    sessionId: string,
    keepFromIndex: number,
    summaryMessage: Message
  ) => void;
  /**
   * 编辑重发专用：只改写 [0, beforeIndex) 前缀，保留 beforeIndex 及之后消息。
   * keepFromIndex 相对于 beforeIndex 之前的 head 切片。
   */
  replaceMessagesPrefixBeforeIndex: (
    sessionId: string,
    beforeIndex: number,
    keepFromIndex: number,
    summaryMessage: Message
  ) => void;
}

export const useChatStore = create<ChatStore>()(
  persist(
    (set, get) => {
      const loadingBusy = makeBusySetActions('loadingSessionIds', set, get);
      const compressingBusy = makeBusySetActions('compressingSessionIds', set, get);
      return {
      sessions: [],
      currentSessionId: null,
      loadingSessionIds: new Set<string>(),
      compressingSessionIds: new Set<string>(),

      createSession: () => {
        const locale = useSettingStore.getState().locale;
        const newSession: ChatSession = {
          id: newId(),
          title: t(locale, 'session.newTitle'),
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        
        set((state: ChatStore) => ({
          sessions: [newSession, ...state.sessions],
          currentSessionId: newSession.id,
        }));
        
        return newSession.id;
      },

      switchSession: (sessionId: string) => {
        set((state: ChatStore) => ({
          currentSessionId: sessionId,
          sessions: state.sessions.map((s: ChatSession) =>
            s.id === sessionId && s.unreadAssistantReply ? { ...s, unreadAssistantReply: false } : s
          ),
        }));
      },

      deleteSession: (sessionId: string) => {
        set((state: ChatStore) => {
          const newSessions = state.sessions.filter((s: ChatSession) => s.id !== sessionId);
          const nextLoading = new Set(state.loadingSessionIds);
          nextLoading.delete(sessionId);
          const nextCompressing = new Set(state.compressingSessionIds);
          nextCompressing.delete(sessionId);
          return {
            sessions: newSessions,
            currentSessionId: state.currentSessionId === sessionId
              ? (newSessions.length > 0 ? newSessions[0].id : null)
              : state.currentSessionId,
            loadingSessionIds: nextLoading,
            compressingSessionIds: nextCompressing,
          };
        });
      },

      addMessage: (sessionId: string, message: Message) => {
        set((state: ChatStore) => ({
          sessions: state.sessions.map((session: ChatSession) =>
            session.id === sessionId
              ? {
                  ...session,
                  messages: [...session.messages, message],
                  updatedAt: Date.now(),
                  ...(message.role === 'assistant'
                    ? {
                        unreadAssistantReply: sessionId !== state.currentSessionId,
                      }
                    : {}),
                }
              : session
          ),
        }));
      },

      /**
       * 编辑重发原子操作：先 updateMessage 改写源消息，再 removeMessages 删除尾部。
       *
       * 业务模块之前手动 getState() 多次操作有 race window（本 action 解决）：
       * - 单 set() 调用，store 订阅者只看到一次变化
       * - 避免"已 update 未 remove"的中间状态
       *
       * 不改变 updateMessage / removeMessages 单独 action 的行为；仅作组合便捷入口。
       */
      resubmitUserMessageAtomically: (
        sessionId: string,
        messageId: string,
        patch: Partial<Message>,
        staleIds: string[]
      ) => {
        set((state: ChatStore) => ({
          sessions: mapSession(state.sessions, sessionId, (session) => ({
            ...session,
            updatedAt: Date.now(),
            messages: session.messages
              .map((m) => (m.id === messageId ? { ...m, ...patch } : m))
              .filter((m) => !staleIds.includes(m.id)),
          })),
        }));
      },

      removeMessage: (sessionId: string, messageId: string) => {
        set((state: ChatStore) => ({
          sessions: mapSession(state.sessions, sessionId, (session) => ({
            ...session,
            updatedAt: Date.now(),
            messages: session.messages.filter((m) => m.id !== messageId),
          })),
        }));
      },

      removeMessages: (sessionId: string, messageIds: string[]) => {
        const idSet = new Set(messageIds);
        if (idSet.size === 0) return;
        set((state: ChatStore) => ({
          sessions: mapSession(state.sessions, sessionId, (session) => ({
            ...session,
            updatedAt: Date.now(),
            messages: session.messages.filter((m) => !idSet.has(m.id)),
          })),
        }));
      },

      updateMessage: (sessionId: string, messageId: string, patch: Partial<Message>) => {
        set((state: ChatStore) => ({
          sessions: mapSession(state.sessions, sessionId, (session) => ({
            ...session,
            updatedAt: Date.now(),
            messages: session.messages.map((m) =>
              m.id === messageId ? { ...m, ...patch } : m
            ),
          })),
        }));
      },

      appendToMessage: (sessionId: string, messageId: string, chunk: string) => {
        set((state: ChatStore) => ({
          sessions: mapSession(state.sessions, sessionId, (session) => ({
            ...session,
            updatedAt: Date.now(),
            messages: session.messages.map((m) =>
              m.id === messageId ? { ...m, content: m.content + chunk } : m
            ),
          })),
        }));
      },

      appendReasoningToMessage: (sessionId: string, messageId: string, chunk: string) => {
        if (!chunk) return;
        set((state: ChatStore) => ({
          sessions: mapSession(state.sessions, sessionId, (session) => ({
            ...session,
            updatedAt: Date.now(),
            messages: session.messages.map((m) =>
              m.id === messageId
                ? { ...m, reasoning: `${m.reasoning ?? ''}${chunk}` }
                : m
            ),
          })),
        }));
      },

      setSessionWebOverride: (sessionId: string, mode: 'default' | 'on' | 'off') => {
        set((state: ChatStore) => ({
          sessions: mapSession(state.sessions, sessionId, (s) => ({
            ...s,
            webSearchOverride: mode,
          })),
        }));
      },

      patchSessionAgentFileScope: (sessionId, patch) => {
        set((state: ChatStore) => ({
          sessions: state.sessions.map((session: ChatSession) => {
            if (session.id !== sessionId) return session;
            const prev = session.agentFileScope?.extraRoots ?? [];
            const nextExtra = patch.extraRoots ?? prev;
            return {
              ...session,
              updatedAt: Date.now(),
              agentFileScope: { extraRoots: [...new Set(nextExtra.map((x) => x.trim()).filter(Boolean))] },
            };
          }),
        }));
      },

      updateSessionTitle: (sessionId: string, title: string) => {
        set((state: ChatStore) => ({
          sessions: mapSession(state.sessions, sessionId, (session) => ({
            ...session,
            title,
          })),
        }));
      },

      setLoadingSession: loadingBusy.add,

      clearLoadingForSession: loadingBusy.remove,

      isLoadingSession: loadingBusy.has,

      setCompressingContext: compressingBusy.add,

      clearCompressingForSession: compressingBusy.remove,

      isCompressingSession: compressingBusy.has,

      replaceMessagesPrefix: (sessionId, keepFromIndex, summaryMessage) => {
        set((state: ChatStore) => ({
          sessions: mapSession(state.sessions, sessionId, (session) => ({
            ...session,
            updatedAt: Date.now(),
            messages: replaceMessagesPrefixCore(session.messages, keepFromIndex, summaryMessage),
          })),
        }));
      },

      replaceMessagesPrefixBeforeIndex: (sessionId, beforeIndex, keepFromIndex, summaryMessage) => {
        set((state: ChatStore) => ({
          sessions: mapSession(state.sessions, sessionId, (session) => ({
            ...session,
            updatedAt: Date.now(),
            messages: replaceMessagesPrefixCore(
              session.messages,
              keepFromIndex,
              summaryMessage,
              beforeIndex
            ),
          })),
        }));
      },
      };
    },
    {
      name: PERSIST_KEYS.chat,
      storage: zustandPersistJson,
      version: 3,
      partialize: (state) => ({
        sessions: state.sessions.map((s) => ({
          ...s,
          messages: s.messages.map(({ imageGenProgress: _skip, ...rest }) => rest),
        })),
        currentSessionId: state.currentSessionId,
        /** loading / compressing 为运行时忙态，故意不落盘，避免异常退出后重启一直转圈 */
      }),
      merge: (persistedState, currentState) => {
        const p = (persistedState ?? {}) as Record<string, unknown>;
        const { loadingSessionIds: _l, compressingSessionIds: _c, loadingSessionId: _ls, compressingSessionId: _cs, ...rest } = p;
        return {
          ...currentState,
          ...rest,
          loadingSessionIds: new Set<string>(),
          compressingSessionIds: new Set<string>(),
        };
      },
      migrate: (state, fromVersion) => {
        if (!state || typeof state !== 'object') return state;
        const s = state as Record<string, unknown>;
        /** v1 → v2: 清除已删除的派生字段 */
        if (fromVersion < 2) {
          delete s.loadingSessionId;
          delete s.compressingSessionId;
        }
        /** v2 → v3: 忙态不再持久化 */
        if (fromVersion < 3) {
          delete s.loadingSessionIds;
          delete s.compressingSessionIds;
          delete s.loadingSessionId;
          delete s.compressingSessionId;
        }
        return state;
      },
    }
  )
);
