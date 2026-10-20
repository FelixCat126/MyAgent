import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '../../store/chatStore';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { useKnowledgeStore } from '../../store/knowledgeStore';
import { useSettingStore } from '../../store/settingStore';
import { buildOutgoingChain } from '../../chat/outgoingChain';
import { resolveSessionProjectContext } from './context';
import { flushZustandFilePersist } from '../../utils/zustandFileStorage';
import type { Message } from '../../types';

const message = (id: string, content: string): Message => ({ id, content, role: 'user', model: 'test', timestamp: Date.now() });

function legacySession(projectId: string): string {
  const id = useChatStore.getState().createSession();
  useChatStore.setState((state) => ({ sessions: state.sessions.map((session) => session.id === id ? { ...session, projectId } : session) }));
  return id;
}

export function resetPersonalStores() {
  useChatStore.setState({ sessions: [], currentSessionId: null, activeLeafId: null, loadingSessionIds: new Set(), compressingSessionIds: new Set() });
  useWorkspaceStore.setState({ rootPath: '', maxChars: 12000 });
  useKnowledgeStore.setState({ vectorRagEnabled: false, embeddingProvider: 'off' });
  useSettingStore.setState({ locale: 'zh' });
}

describe('legacy project fields on conversations', () => {
  beforeEach(() => { resetPersonalStores(); vi.restoreAllMocks(); });

  it('never associates new conversations and treats legacy project ids as inert metadata', () => {
    useWorkspaceStore.getState().setRootPath('/general');
    const original = useChatStore.getState().createSession();
    const fresh = useChatStore.getState().createSession('contracts');
    const projectSession = legacySession('contracts');
    expect(resolveSessionProjectContext(original).rootPath).toBe('/general');
    expect(useChatStore.getState().sessions.find((session) => session.id === fresh)?.projectId).toBeUndefined();
    expect(resolveSessionProjectContext(projectSession)).toMatchObject({ projectId: null, rootPath: '/general', rules: '', isProjectSession: false });
    useChatStore.getState().assignSessionProject(original, 'music');
    expect(useChatStore.getState().sessions.find((session) => session.id === original)?.projectId).toBeUndefined();
    expect(useChatStore.getState().sessions.find((session) => session.id === projectSession)?.projectId).toBe('contracts');
  });

  it('does not change the project scope of conversations while a request is in progress', () => {
    const sid = legacySession('running');
    useChatStore.getState().setLoadingSession(sid);
    expect(() => useChatStore.getState().assignSessionProject(sid, null)).toThrow('conversation-busy');
    expect(resolveSessionProjectContext(sid).projectId).toBeNull();
    useChatStore.getState().clearLoadingForSession(sid);
    useChatStore.getState().assignSessionProject(sid, null);
    expect(useChatStore.getState().sessions[0].projectId).toBeNull();
  });

  it('persists legacy session membership for backup and restart', async () => {
    legacySession('persisted');
    await flushZustandFilePersist();
    expect(JSON.parse(localStorage.getItem('chat-storage')!).state.sessions[0].projectId).toBe('persisted');
  });
});

describe('outgoing integration', () => {
  beforeEach(() => { resetPersonalStores(); vi.restoreAllMocks(); });

  it('reads only the ordinary reference directory for old project conversations and preserves attachments', async () => {
    useWorkspaceStore.getState().setRootPath('/general-private');
    const sa = legacySession('project-a');
    useChatStore.getState().createSession('project-b');
    useKnowledgeStore.setState({ vectorRagEnabled: true, embeddingProvider: 'ollama' });
    const workspace = vi.spyOn(window.electron, 'readWorkspaceHint').mockResolvedValue({ ok: true, text: 'A目录资料', fileName: 'README.md' });
    const search = vi.spyOn(window.electron, 'knowledgeSearch').mockResolvedValue({ ok: true, text: 'A检索片段', meta: { chunkCount: 3, usedChunks: 1 } });
    const user = { ...message('u', '总结资料'), files: [{ name: 'uploaded.csv', path: '/uploads/uploaded.csv', type: 'text/csv', size: 10 }] };
    const outgoing = await buildOutgoingChain([], user, { enabled: false, provider: 'duckduckgo', apiKey: '' }, { sessionId: sa });
    expect(workspace).toHaveBeenCalledWith({ root: '/general-private', maxChars: 12000 });
    expect(search.mock.calls[0][0].root).toBe('/general-private');
    expect(outgoing.chain[outgoing.chain.length - 1].role).toBe('user');
    expect(outgoing.chain[outgoing.chain.length - 1].files).toEqual(user.files);
    expect(outgoing.ragHint).toMatchObject({ kind: 'injected', usedChunks: 1 });
  });

  it('index/search failures produce no wrong-root snippets and preserve normal conversation', async () => {
    const sa = legacySession('a');
    useKnowledgeStore.setState({ vectorRagEnabled: true, embeddingProvider: 'ollama' });
    vi.spyOn(window.electron, 'knowledgeSearch').mockResolvedValue({ ok: false, error: 'Index belongs to /b' });
    vi.spyOn(window.electron, 'readWorkspaceHint').mockResolvedValue({ ok: false, error: 'missing' });
    const outgoing = await buildOutgoingChain([], message('u', '问题'), { enabled: false, provider: 'duckduckgo', apiKey: '' }, { sessionId: sa });
    expect(outgoing.ragHint.kind).toBe('error');
    expect(outgoing.chain[outgoing.chain.length - 1].content).toBe('问题');
    expect(outgoing.chain.some((m) => m.model === 'vector-rag')).toBe(false);
  });

  it('keeps ordinary history unchanged and bookmarks do not enter model context', async () => {
    const sid = useChatStore.getState().createSession();
    const user = message('u', 'hello');
    useChatStore.getState().addMessage(sid, user);
    useChatStore.getState().toggleMessageBookmark(sid, user.id);
    useChatStore.getState().renameBranch(sid, user.id, '路线 A');
    const prior: Message[] = [{ ...message('previous', '历史回答'), role: 'assistant' }];
    expect((await buildOutgoingChain(prior, user, { enabled: false, provider: 'duckduckgo', apiKey: '' }, { sessionId: sid })).chain).toEqual([...prior, user]);
    expect(useChatStore.getState().sessions[0].branchNames).toEqual({ u: '路线 A' });
    useChatStore.getState().toggleMessageBookmark(sid, user.id);
    expect(useChatStore.getState().sessions[0].bookmarkedMessageIds).toEqual([]);
  });
});
