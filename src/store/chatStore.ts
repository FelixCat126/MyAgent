import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ChatSession, Message } from '../types';
import { zustandPersistJson } from '../utils/zustandFileStorage';
import { t } from '../i18n/ui';
import { useSettingStore } from './settingStore';

interface ChatStore {
  sessions: ChatSession[];
  currentSessionId: string | null;
  /** 正在等待模型回复的会话 id；仅该会话内显示加载动画 */
  loadingSessionId: string | null;

  // Actions
  createSession: () => string;
  switchSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  addMessage: (sessionId: string, message: Message) => void;
  removeMessage: (sessionId: string, messageId: string) => void;
  updateMessage: (sessionId: string, messageId: string, patch: Partial<Message>) => void;
  appendToMessage: (sessionId: string, messageId: string, chunk: string) => void;
  appendReasoningToMessage: (sessionId: string, messageId: string, chunk: string) => void;
  setSessionWebOverride: (sessionId: string, mode: 'default' | 'on' | 'off') => void;
  updateSessionTitle: (sessionId: string, title: string) => void;
  setLoadingSession: (sessionId: string | null) => void;
  clearLoadingForSession: (sessionId: string) => void;
}

export const useChatStore = create<ChatStore>()(
  persist(
    (set) => ({
      sessions: [],
      currentSessionId: null,
      loadingSessionId: null,

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
          return {
            sessions: newSessions,
            currentSessionId: state.currentSessionId === sessionId 
              ? (newSessions.length > 0 ? newSessions[0].id : null)
              : state.currentSessionId,
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

      updateSessionTitle: (sessionId: string, title: string) => {
        set((state: ChatStore) => ({
          sessions: state.sessions.map((session: ChatSession) =>
            session.id === sessionId ? { ...session, title } : session
          ),
        }));
      },

      setLoadingSession: (sessionId: string | null) => {
        set({ loadingSessionId: sessionId });
      },

      clearLoadingForSession: (sessionId: string) => {
        set((state: ChatStore) =>
          state.loadingSessionId === sessionId ? { loadingSessionId: null } : {}
        );
      },
    }),
    {
      name: 'chat-storage',
      storage: zustandPersistJson,
      partialize: (state) => ({
        sessions: state.sessions,
        currentSessionId: state.currentSessionId,
      }),
    }
  )
);
