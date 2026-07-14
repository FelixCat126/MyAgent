import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ChatSession, Message } from '../types';
import { zustandPersistJson } from '../utils/zustandFileStorage';
import { t } from '../i18n/ui';
import { useSettingStore } from './settingStore';

interface ChatStore {
  sessions: ChatSession[];
  currentSessionId: string | null;
  /** 正在等待模型回复的会话 id（派生：取 loadingSessionIds 第一个，兼容旧代码） */
  loadingSessionId: string | null;
  /** 正在执行/等待回复的会话 id 集合（支持多会话并发转圈） */
  loadingSessionIds: string[];
  /**
   * 正在自动压缩上下文的会话集合（对齐 loadingSessionIds，支持多会话）。
   * compressingSessionId 为派生：取集合第一个，兼容旧 UI。
   */
  compressingSessionIds: string[];
  compressingSessionId: string | null;

  // Actions
  createSession: () => string;
  switchSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  addMessage: (sessionId: string, message: Message) => void;
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
    (set, get) => ({
      sessions: [],
      currentSessionId: null,
      loadingSessionId: null,
      loadingSessionIds: [],
      compressingSessionIds: [],
      compressingSessionId: null,

      createSession: () => {
        const locale = useSettingStore.getState().locale;
        const newSession: ChatSession = {
          id: Date.now().toString(),
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
          const nextLoading = state.loadingSessionIds.filter((id) => id !== sessionId);
          const nextCompressing = state.compressingSessionIds.filter((id) => id !== sessionId);
          return {
            sessions: newSessions,
            currentSessionId: state.currentSessionId === sessionId 
              ? (newSessions.length > 0 ? newSessions[0].id : null)
              : state.currentSessionId,
            loadingSessionIds: nextLoading,
            loadingSessionId: nextLoading[0] ?? null,
            compressingSessionIds: nextCompressing,
            compressingSessionId: nextCompressing[0] ?? null,
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

      removeMessage: (sessionId: string, messageId: string) => {
        set((state: ChatStore) => ({
          sessions: state.sessions.map((session: ChatSession) =>
            session.id === sessionId
              ? {
                  ...session,
                  updatedAt: Date.now(),
                  messages: session.messages.filter((m) => m.id !== messageId),
                }
              : session
          ),
        }));
      },

      removeMessages: (sessionId: string, messageIds: string[]) => {
        const idSet = new Set(messageIds);
        if (idSet.size === 0) return;
        set((state: ChatStore) => ({
          sessions: state.sessions.map((session: ChatSession) =>
            session.id === sessionId
              ? {
                  ...session,
                  updatedAt: Date.now(),
                  messages: session.messages.filter((m) => !idSet.has(m.id)),
                }
              : session
          ),
        }));
      },

      updateMessage: (sessionId: string, messageId: string, patch: Partial<Message>) => {
        set((state: ChatStore) => ({
          sessions: state.sessions.map((session: ChatSession) =>
            session.id === sessionId
              ? {
                  ...session,
                  updatedAt: Date.now(),
                  messages: session.messages.map((m) =>
                    m.id === messageId ? { ...m, ...patch } : m
                  ),
                }
              : session
          ),
        }));
      },

      appendToMessage: (sessionId: string, messageId: string, chunk: string) => {
        set((state: ChatStore) => ({
          sessions: state.sessions.map((session: ChatSession) =>
            session.id === sessionId
              ? {
                  ...session,
                  updatedAt: Date.now(),
                  messages: session.messages.map((m) =>
                    m.id === messageId ? { ...m, content: m.content + chunk } : m
                  ),
                }
              : session
          ),
        }));
      },

      appendReasoningToMessage: (sessionId: string, messageId: string, chunk: string) => {
        if (!chunk) return;
        set((state: ChatStore) => ({
          sessions: state.sessions.map((session: ChatSession) =>
            session.id === sessionId
              ? {
                  ...session,
                  updatedAt: Date.now(),
                  messages: session.messages.map((m) =>
                    m.id === messageId
                      ? { ...m, reasoning: `${m.reasoning ?? ''}${chunk}` }
                      : m
                  ),
                }
              : session
          ),
        }));
      },

      setSessionWebOverride: (sessionId: string, mode: 'default' | 'on' | 'off') => {
        set((state: ChatStore) => ({
          sessions: state.sessions.map((s: ChatSession) =>
            s.id === sessionId ? { ...s, webSearchOverride: mode } : s
          ),
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
          sessions: state.sessions.map((session: ChatSession) =>
            session.id === sessionId ? { ...session, title } : session
          ),
        }));
      },

      setLoadingSession: (sessionId: string | null) => {
        /** null = 清空全部；非 null = 加入集合（支持多会话并发转圈） */
        if (sessionId === null) {
          set({ loadingSessionId: null, loadingSessionIds: [] });
        } else {
          set((state: ChatStore) => {
            if (state.loadingSessionIds.includes(sessionId)) {
              return { loadingSessionId: state.loadingSessionIds[0] ?? null };
            }
            const next = [...state.loadingSessionIds, sessionId];
            return { loadingSessionId: next[0] ?? null, loadingSessionIds: next };
          });
        }
      },

      clearLoadingForSession: (sessionId: string) => {
        set((state: ChatStore) => {
          /** 要清除的 id 不在加载集合中 → 状态不变 */
          if (!state.loadingSessionIds.includes(sessionId)) {
            return {};
          }
          const next = state.loadingSessionIds.filter((id) => id !== sessionId);
          /** 回复完成时，若用户已切到别的会话，标记未读（亮点提示） */
          const becameUnread = sessionId !== state.currentSessionId;
          return {
            loadingSessionId: next[0] ?? null,
            loadingSessionIds: next,
            ...(becameUnread
              ? {
                  sessions: state.sessions.map((s: ChatSession) =>
                    s.id === sessionId ? { ...s, unreadAssistantReply: true } : s
                  ),
                }
              : {}),
          };
        });
      },

      isLoadingSession: (sessionId: string): boolean => {
        return get().loadingSessionIds.includes(sessionId);
      },

      setCompressingContext: (sessionId: string | null) => {
        if (sessionId === null) {
          set({ compressingSessionId: null, compressingSessionIds: [] });
          return;
        }
        set((state: ChatStore) => {
          if (state.compressingSessionIds.includes(sessionId)) {
            return { compressingSessionId: state.compressingSessionIds[0] ?? null };
          }
          const next = [...state.compressingSessionIds, sessionId];
          return { compressingSessionId: next[0] ?? null, compressingSessionIds: next };
        });
      },

      clearCompressingForSession: (sessionId: string) => {
        set((state: ChatStore) => {
          if (!state.compressingSessionIds.includes(sessionId)) return {};
          const next = state.compressingSessionIds.filter((id) => id !== sessionId);
          return {
            compressingSessionId: next[0] ?? null,
            compressingSessionIds: next,
          };
        });
      },

      isCompressingSession: (sessionId: string): boolean => {
        return get().compressingSessionIds.includes(sessionId);
      },

      replaceMessagesPrefix: (sessionId, keepFromIndex, summaryMessage) => {
        set((state: ChatStore) => ({
          sessions: state.sessions.map((session: ChatSession) => {
            if (session.id !== sessionId) return session;
            const idx = Math.max(0, Math.min(keepFromIndex, session.messages.length));
            const recent = session.messages.slice(idx);
            return {
              ...session,
              updatedAt: Date.now(),
              messages: [summaryMessage, ...recent],
            };
          }),
        }));
      },

      replaceMessagesPrefixBeforeIndex: (sessionId, beforeIndex, keepFromIndex, summaryMessage) => {
        set((state: ChatStore) => ({
          sessions: state.sessions.map((session: ChatSession) => {
            if (session.id !== sessionId) return session;
            const end = Math.max(0, Math.min(beforeIndex, session.messages.length));
            const head = session.messages.slice(0, end);
            const tail = session.messages.slice(end);
            const idx = Math.max(0, Math.min(keepFromIndex, head.length));
            const recentPrior = head.slice(idx);
            return {
              ...session,
              updatedAt: Date.now(),
              messages: [summaryMessage, ...recentPrior, ...tail],
            };
          }),
        }));
      },
    }),
    {
      name: 'chat-storage',
      storage: zustandPersistJson,
      partialize: (state) => ({
        sessions: state.sessions.map((s) => ({
          ...s,
          messages: s.messages.map(({ imageGenProgress: _skip, ...rest }) => rest),
        })),
        currentSessionId: state.currentSessionId,
      }),
    }
  )
);
