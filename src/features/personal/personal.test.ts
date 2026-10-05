import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore, restoreProjects } from '../../store/projectStore';
import { useMemoryStore, restoreMemories } from '../../store/memoryStore';
import { useWorkflowStore, renderWorkflow, restoreWorkflows } from '../../store/workflowStore';
import { useChatStore } from '../../store/chatStore';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { useKnowledgeStore } from '../../store/knowledgeStore';
import { useSettingStore } from '../../store/settingStore';
import { buildOutgoingChain } from '../../chat/outgoingChain';
import { deleteProjectWithoutLosingConversations, isExplicitMemoryCommand, personalContextMessage, relevantMemories, resolveSessionProjectContext, reviewMemoryCandidatesFromMessage, tryHandleMemoryCommand } from './context';
import { flushZustandFilePersist } from '../../utils/zustandFileStorage';
import type { Message } from '../../types';

const message = (id: string, content: string): Message => ({ id, content, role: 'user', model: 'test', timestamp: Date.now() });

function legacySession(projectId: string): string {
  const id = useChatStore.getState().createSession();
  useChatStore.setState((state) => ({ sessions: state.sessions.map((session) => session.id === id ? { ...session, projectId } : session) }));
  return id;
}

function legacyWorkflow(projectId: string): string {
  const id = 'legacy-workflow';
  useWorkflowStore.setState({ workflows: restoreWorkflows([{ id, name: '报告', template: '生成 {{日期}} 报告', projectId, outputFormat: 'docx' }]) });
  return id;
}

export function resetPersonalStores() {
  useProjectStore.setState({ projects: [], activeProjectId: null });
  useMemoryStore.setState({ memories: [], candidateExtractionEnabled: true });
  useWorkflowStore.setState({ workflows: [] });
  useChatStore.setState({ sessions: [], currentSessionId: null, activeLeafId: null, loadingSessionIds: new Set(), compressingSessionIds: new Set() });
  useWorkspaceStore.setState({ rootPath: '', maxChars: 12000 });
  useKnowledgeStore.setState({ vectorRagEnabled: false, embeddingProvider: 'off' });
  useSettingStore.setState({ locale: 'zh' });
}

describe('legacy workspace data compatibility', () => {
  beforeEach(() => { resetPersonalStores(); vi.restoreAllMocks(); });

  it('never associates new conversations and treats legacy project rules and roots as inert metadata', () => {
    useWorkspaceStore.getState().setRootPath('/general');
    const original = useChatStore.getState().createSession();
    const a = useProjectStore.getState().createProject({ name: '合同项目', rootPath: '/contracts', rules: '所有引用写页码' });
    const fresh = useChatStore.getState().createSession(a);
    const projectSession = legacySession(a);
    const b = useProjectStore.getState().createProject({ name: '音乐项目', rootPath: '/music', rules: '保留原伴奏' });
    expect(resolveSessionProjectContext(original).rootPath).toBe('/general');
    expect(useChatStore.getState().sessions.find((session) => session.id === fresh)?.projectId).toBeUndefined();
    expect(resolveSessionProjectContext(projectSession)).toMatchObject({ projectId: null, rootPath: '/general', rules: '', isProjectSession: false });
    expect(personalContextMessage('审阅合同', projectSession)).toBeNull();
    useChatStore.getState().assignSessionProject(original, b);
    expect(resolveSessionProjectContext(original).rootPath).toBe('/general');
    useChatStore.getState().assignSessionProject(original, 'invalid');
    expect(useChatStore.getState().sessions.find((session) => session.id === original)?.projectId).toBeUndefined();
    expect(useChatStore.getState().sessions.find((session) => session.id === projectSession)?.projectId).toBe(a);
  });

  it('removing a project preserves conversation messages and recipes but archives project memories', () => {
    const id = useProjectStore.getState().createProject({ name: 'Project' });
    const sid = legacySession(id);
    useChatStore.getState().addMessage(sid, message('u', '原始内容'));
    const wid = legacyWorkflow(id);
    useMemoryStore.getState().addMemory({ content: '合同金额是 123 元', scope: 'project', projectId: id, alwaysApply: true });
    deleteProjectWithoutLosingConversations(id);
    expect(useChatStore.getState().sessions[0]).toMatchObject({ projectId: null, messages: [{ id: 'u', content: '原始内容' }] });
    expect(useWorkflowStore.getState().workflows.find((w) => w.id === wid)?.projectId).toBeNull();
    expect(personalContextMessage('合同', sid)).toBeNull();
    expect(useMemoryStore.getState().memories).toHaveLength(1);
  });

  it('old sessions with missing projects use only the ordinary directory without changing legacy memory data', () => {
    useWorkspaceStore.getState().setRootPath('/private-other-project');
    const project = useProjectStore.getState().createProject({ name: '独立项目' });
    const sid = legacySession(project);
    expect(resolveSessionProjectContext(sid).rootPath).toBe('/private-other-project');
    useProjectStore.getState().deleteProject(project);
    expect(resolveSessionProjectContext(sid).rootPath).toBe('/private-other-project');
    expect(tryHandleMemoryCommand('记住：回答简洁', sid, 'source')).toEqual({ handled: false });
    expect(reviewMemoryCandidatesFromMessage(sid, message('source', '我喜欢报告使用表格'))).toEqual([]);
    expect(useMemoryStore.getState().memories).toEqual([]);
  });

  it('does not change the project scope of conversations while a request is in progress', () => {
    const project = useProjectStore.getState().createProject({ name: '运行中的项目' });
    const sid = legacySession(project);
    useChatStore.getState().setLoadingSession(sid);
    expect(() => useChatStore.getState().assignSessionProject(sid, null)).toThrow('conversation-busy');
    expect(() => deleteProjectWithoutLosingConversations(project)).toThrow('conversation-busy');
    expect(resolveSessionProjectContext(sid).projectId).toBeNull();
    useChatStore.getState().clearLoadingForSession(sid);
    deleteProjectWithoutLosingConversations(project);
    expect(useChatStore.getState().sessions[0].projectId).toBeNull();
  });

  it('validates names and roots and ignores corrupt hydration records', () => {
    expect(() => useProjectStore.getState().createProject({ name: ' ' })).toThrow('required');
    expect(() => useProjectStore.getState().createProject({ name: 'x', rootPath: 'relative/folder' })).toThrow('absolute-path');
    useProjectStore.getState().createProject({ name: 'same' });
    expect(() => useProjectStore.getState().createProject({ name: 'SAME' })).toThrow('duplicate-name');
    expect(restoreProjects([{ id: 'bad', name: '', rootPath: '/ok' }, { id: 'ok', name: 'Good', rootPath: '/ok', createdAt: 1 }])).toHaveLength(1);
    expect(restoreMemories([{ id: 'bad', content: 'x', scope: 'project' }])).toEqual([]);
    expect(restoreWorkflows([{ id: 'bad', name: 'x', template: '' }])).toEqual([]);
  });

  it('persists complete project, memory, workflow and session membership for backup and restart', async () => {
    const pid = useProjectStore.getState().createProject({ name: '持久化', rules: '规则', rootPath: '/project' });
    const sid = legacySession(pid);
    useMemoryStore.getState().addMemory({ content: '固定事实', scope: 'project', projectId: pid, source: { kind: 'message', sessionId: sid, messageId: 'source' } });
    legacyWorkflow(pid);
    await flushZustandFilePersist();
    const storedProjects = JSON.parse(localStorage.getItem('project-storage')!);
    const storedMemories = JSON.parse(localStorage.getItem('memory-storage')!);
    const storedWorkflows = JSON.parse(localStorage.getItem('workflow-storage')!);
    expect(storedProjects.state.projects[0].rootPath).toBe('/project');
    expect(storedMemories.state.memories[0].source.messageId).toBe('source');
    expect(storedWorkflows.state.workflows[0].variables).toEqual([{ name: '日期', label: '日期', defaultValue: '', required: true }]);
    expect(JSON.parse(localStorage.getItem('chat-storage')!).state.sessions[0].projectId).toBe(pid);
    useProjectStore.setState({ projects: [], activeProjectId: null });
    // setState writes asynchronously; restore the saved envelope before rehydration.
    localStorage.setItem('project-storage', JSON.stringify(storedProjects));
    await useProjectStore.persist.rehydrate();
    expect(useProjectStore.getState().projects[0].id).toBe(pid);
  });
});

describe('retired workspace memory boundaries', () => {
  beforeEach(() => { resetPersonalStores(); vi.restoreAllMocks(); });

  it.each([
    '请记住：合同编号为 123', '记住以下内容：', '忘掉', '忘掉全部记忆',
    'remember that I prefer short replies', 'forget all memories', '/remember private fact', '/forget private fact',
  ])('leaves %s on the ordinary chat path without saving or deleting memories', text => {
    const sid = legacySession('legacy-project');
    useMemoryStore.getState().addMemory({ content: '合同编号为 123', scope: 'personal', alwaysApply: true });
    useMemoryStore.getState().addMemory({ content: '项目资料', scope: 'project', projectId: 'legacy-project', status: 'candidate' });
    const original = structuredClone(useMemoryStore.getState().memories);
    for (const locale of ['zh', 'en'] as const) {
      useSettingStore.setState({ locale });
      expect(isExplicitMemoryCommand(text)).toBe(false);
      expect(tryHandleMemoryCommand(text, sid, 'user-1')).toEqual({ handled: false });
      expect(tryHandleMemoryCommand(text, 'missing-session', 'user-2')).toEqual({ handled: false });
    }
    expect(useMemoryStore.getState().memories).toEqual(original);
  });

  it('never extracts new candidates even when the old extraction setting is enabled', () => {
    const sid = useChatStore.getState().createSession();
    useMemoryStore.getState().addMemory({ content: '旧候选', scope: 'personal', status: 'candidate' });
    const original = structuredClone(useMemoryStore.getState().memories);
    expect(reviewMemoryCandidatesFromMessage(sid, message('u', '我喜欢报告中使用表格。以后请用英文回答。'))).toEqual([]);
    expect(reviewMemoryCandidatesFromMessage(sid, message('en', 'I prefer short replies. From now on use tables.'))).toEqual([]);
    expect(reviewMemoryCandidatesFromMessage(sid, { ...message('a', '我喜欢虚构内容'), role: 'assistant' })).toEqual([]);
    useMemoryStore.getState().setCandidateExtractionEnabled(false);
    expect(reviewMemoryCandidatesFromMessage(sid, message('x', '我喜欢英文标题'))).toEqual([]);
    expect(useMemoryStore.getState().memories).toEqual(original);
  });

  it('keeps confirmed, always-applied and candidate memories out of model context in ordinary and legacy sessions', async () => {
    const ordinary = useChatStore.getState().createSession();
    const legacy = legacySession('legacy-project');
    useMemoryStore.getState().addMemory({ content: 'SENTINEL_PERSONAL_MEMORY', scope: 'personal', alwaysApply: true });
    useMemoryStore.getState().addMemory({ content: 'SENTINEL_CANDIDATE_MEMORY', scope: 'personal', status: 'candidate' });
    useMemoryStore.getState().addMemory({ content: 'SENTINEL_PROJECT_MEMORY', scope: 'project', projectId: 'legacy-project', alwaysApply: true });
    const original = structuredClone(useMemoryStore.getState().memories);
    for (const sessionId of [ordinary, legacy]) {
      expect(personalContextMessage('SENTINEL', sessionId)).toBeNull();
      const user = message('request', '请回答这个问题');
      const prior: Message[] = [{ ...message('previous', '历史回答'), role: 'assistant' }];
      const outgoing = await buildOutgoingChain(prior, user, { enabled: false, provider: 'duckduckgo', apiKey: '' }, { sessionId });
      expect(outgoing.chain).toEqual([...prior, user]);
      expect(outgoing.chain.some(message => message.model === 'myagent-personal-context')).toBe(false);
    }
    expect(useMemoryStore.getState().memories).toEqual(original);
  });

  it('preserves the pure relevance helper and legacy memory restoration for backups', () => {
    useMemoryStore.getState().addMemory({ content: '个人偏好', scope: 'personal', alwaysApply: true });
    useMemoryStore.getState().addMemory({ content: '旧候选', scope: 'personal', status: 'candidate', alwaysApply: true });
    useMemoryStore.getState().addMemory({ content: '旧项目事实', scope: 'project', projectId: 'legacy-project', alwaysApply: true });
    const original = useMemoryStore.getState().memories;
    expect(relevantMemories(original, '问题', 'legacy-project').map(memory => memory.content)).toEqual(['个人偏好']);
    expect(relevantMemories(original, '问题', null, 1)).toEqual([]);
    expect(restoreMemories(JSON.parse(JSON.stringify(original)))).toEqual(original);
    expect(personalContextMessage('问题')).toBeNull();
  });
});

describe('workflow execution and outgoing integration', () => {
  beforeEach(() => { resetPersonalStores(); vi.restoreAllMocks(); });

  it('creates ordinary workflows and preserves an old recipe as runnable metadata after its project is gone', () => {
    const created = useWorkflowStore.getState().createWorkflow({ name: '新配方', template: '生成报告', projectId: 'old-project' });
    expect(useWorkflowStore.getState().workflows.find((workflow) => workflow.id === created)?.projectId).toBeNull();
    const id = legacyWorkflow('deleted-project');
    useWorkflowStore.getState().updateWorkflow(id, { name: '继续旧配方', projectId: 'another-project' });
    const workflow = useWorkflowStore.getState().workflows.find((entry) => entry.id === id)!;
    expect(workflow.projectId).toBe('deleted-project');
    expect(renderWorkflow(workflow, { 日期: '周五' })).toContain('生成 周五 报告');
    useWorkflowStore.getState().updateWorkflow(id, { projectId: null });
    expect(useWorkflowStore.getState().workflows[0].projectId).toBeNull();
  });

  it('renders variables, validates required inputs and appends a file output request', () => {
    const id = useWorkflowStore.getState().createWorkflow({ name: '周报', template: '生成 {{日期}} 的 {{资料}} 报告。{{日期}}', outputFormat: 'docx', variables: [{ name: '日期', label: '日期', defaultValue: '周五', required: true }, { name: '资料', label: '材料', defaultValue: '', required: true }] });
    const workflow = useWorkflowStore.getState().workflows.find((w) => w.id === id)!;
    expect(workflow.variables).toHaveLength(2);
    expect(() => renderWorkflow(workflow, {})).toThrow('required');
    const prompt = renderWorkflow(workflow, { 资料: '本周进展' });
    expect(prompt).toContain('生成 周五 的 本周进展 报告。周五');
    expect(prompt).toContain('DOCX 文件');
    expect(renderWorkflow(workflow, { 日期: '{{不会被再次替换}}', 资料: '$&' })).toContain('$&');
    expect(() => useWorkflowStore.getState().createWorkflow({ name: 'bad', template: '{{invalid name}}' })).toThrow('invalid-variable');
  });

  it('reads only the ordinary reference directory for old project conversations and preserves attachments', async () => {
    useWorkspaceStore.getState().setRootPath('/general-private');
    const a = useProjectStore.getState().createProject({ name: 'A', rootPath: '/project-a', rules: 'A的规则' });
    const sa = legacySession(a);
    const b = useProjectStore.getState().createProject({ name: 'B', rootPath: '/project-b', rules: 'B的规则' });
    useChatStore.getState().createSession(b);
    useKnowledgeStore.setState({ vectorRagEnabled: true, embeddingProvider: 'ollama' });
    const workspace = vi.spyOn(window.electron, 'readWorkspaceHint').mockResolvedValue({ ok: true, text: 'A目录资料', fileName: 'README.md' });
    const search = vi.spyOn(window.electron, 'knowledgeSearch').mockResolvedValue({ ok: true, text: 'A检索片段', meta: { chunkCount: 3, usedChunks: 1 } });
    const user = { ...message('u', '总结资料'), files: [{ name: 'uploaded.csv', path: '/uploads/uploaded.csv', type: 'text/csv', size: 10 }] };
    const outgoing = await buildOutgoingChain([], user, { enabled: false, provider: 'duckduckgo', apiKey: '' }, { sessionId: sa });
    expect(workspace).toHaveBeenCalledWith({ root: '/general-private', maxChars: 12000 });
    expect(search.mock.calls[0][0].root).toBe('/general-private');
    expect(outgoing.chain.map((m) => m.content).join('\n')).not.toContain('A的规则');
    expect(outgoing.chain.map((m) => m.content).join('\n')).not.toContain('B的规则');
    expect(outgoing.chain[outgoing.chain.length - 1].role).toBe('user');
    expect(outgoing.chain[outgoing.chain.length - 1].files).toEqual(user.files);
    expect(outgoing.ragHint).toMatchObject({ kind: 'injected', usedChunks: 1 });
  });

  it('index/search failures produce no wrong-root snippets and preserve normal conversation', async () => {
    const a = useProjectStore.getState().createProject({ name: 'A', rootPath: '/a' });
    const sa = useChatStore.getState().createSession(a);
    useKnowledgeStore.setState({ vectorRagEnabled: true, embeddingProvider: 'ollama' });
    vi.spyOn(window.electron, 'knowledgeSearch').mockResolvedValue({ ok: false, error: 'Index belongs to /b' });
    vi.spyOn(window.electron, 'readWorkspaceHint').mockResolvedValue({ ok: false, error: 'missing' });
    const outgoing = await buildOutgoingChain([], message('u', '问题'), { enabled: false, provider: 'duckduckgo', apiKey: '' }, { sessionId: sa });
    expect(outgoing.ragHint.kind).toBe('error');
    expect(outgoing.chain[outgoing.chain.length - 1].content).toBe('问题');
    expect(outgoing.chain.some((m) => m.model === 'vector-rag')).toBe(false);
  });

  it('keeps existing no-project/no-memory behavior unchanged and bookmarks do not enter model context', async () => {
    const sid = useChatStore.getState().createSession();
    const user = message('u', 'hello');
    useChatStore.getState().addMessage(sid, user);
    useChatStore.getState().toggleMessageBookmark(sid, user.id);
    useChatStore.getState().renameBranch(sid, user.id, '路线 A');
    const outgoing = await buildOutgoingChain([], user, { enabled: false, provider: 'duckduckgo', apiKey: '' }, { sessionId: sid });
    expect(outgoing.chain).toEqual([user]);
    expect(useChatStore.getState().sessions[0].branchNames).toEqual({ u: '路线 A' });
    useChatStore.getState().toggleMessageBookmark(sid, user.id);
    expect(useChatStore.getState().sessions[0].bookmarkedMessageIds).toEqual([]);
  });
});
