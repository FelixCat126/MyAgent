import type { Message } from '../../types';
import { useChatStore } from '../../store/chatStore';
import { useProjectStore } from '../../store/projectStore';
import { useWorkflowStore } from '../../store/workflowStore';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { memoryTokens } from './validation';
import type { PersonalMemory } from './types';

export function resolveSessionProjectContext(sessionId?: string | null) {
  const id = sessionId ?? useChatStore.getState().currentSessionId;
  // Legacy project fields remain stored for backups, but no longer grant context or file access.
  return {
    sessionId: id ?? null,
    projectId: null,
    isProjectSession: false,
    project: undefined,
    rootPath: useWorkspaceStore.getState().rootPath.trim(),
    rules: '',
  };
}

export function relevantMemories(memories: PersonalMemory[], query: string, _legacyProjectId: string | null, maxChars = 6000): PersonalMemory[] {
  const tokens = new Set(memoryTokens(query));
  const eligible = memories.filter((m) => m.status === 'confirmed' && m.scope === 'personal');
  const ranked = eligible.map((memory) => ({
    memory,
    score: memory.alwaysApply ? 100 : memory.keywords.reduce((sum, token) => sum + (tokens.has(token) ? 1 : 0), 0),
  })).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt);
  let budget = Math.max(0, maxChars);
  const picked: PersonalMemory[] = [];
  for (const { memory } of ranked) {
    if (picked.length >= 8) break;
    if (memory.content.length > budget) continue;
    budget -= memory.content.length;
    picked.push(memory);
  }
  return picked;
}

/** Compatibility boundary: retired workspace memories never enter model requests. */
export function personalContextMessage(_query: string, _sessionId?: string | null): Message | null {
  return null;
}

export function deleteProjectWithoutLosingConversations(projectId: string): void {
  const chat = useChatStore.getState();
  if (chat.sessions.some((session) => session.projectId === projectId && (chat.isLoadingSession(session.id) || chat.isCompressingSession(session.id)))) throw new Error('conversation-busy');
  // Detach first: an interrupted removal can never delete or hide conversations.
  useChatStore.getState().detachProjectSessions(projectId);
  useWorkflowStore.getState().detachProjectWorkflows(projectId);
  useProjectStore.getState().deleteProject(projectId);
  // Project memories remain archived in their original scope, never promoted to personal.
}

export interface MemoryCommandResult { handled: boolean; reply?: string; memoryIds?: string[] }
export function isExplicitMemoryCommand(_userText: string): boolean {
  return false;
}

/** Memory-shaped requests use the ordinary model path and leave legacy records intact. */
export function tryHandleMemoryCommand(_userText: string, _sessionId: string, _sourceMessageId: string): MemoryCommandResult {
  return { handled: false };
}

/** Candidate extraction is retired along with its review interface. */
export function reviewMemoryCandidatesFromMessage(_sessionId: string, _userMessage: Pick<Message, 'id' | 'role' | 'content'>): string[] {
  return [];
}
