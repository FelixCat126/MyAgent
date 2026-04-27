import { ChatSession } from '../types';

/** 与 SessionList 一致：按标题与消息正文子串过滤（不区分大小写） */
export function filterSessionsByQuery(sessions: ChatSession[], search: string): ChatSession[] {
  const t = search.trim().toLowerCase();
  if (!t) return sessions;
  return sessions.filter((s) => {
    if (s.title.toLowerCase().includes(t)) return true;
    return s.messages.some((m) => m.content.toLowerCase().includes(t));
  });
}
