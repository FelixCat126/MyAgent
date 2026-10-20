import { useChatStore } from '../../store/chatStore';
import { useWorkspaceStore } from '../../store/workspaceStore';

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
