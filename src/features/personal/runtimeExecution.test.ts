import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '../../store/chatStore';
import { useModelStore } from '../../store/modelStore';
import { useProjectStore } from '../../store/projectStore';
import { useMemoryStore } from '../../store/memoryStore';
import { useKnowledgeStore } from '../../store/knowledgeStore';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { useSettingStore } from '../../store/settingStore';
import { buildOutgoingChain } from '../../chat/outgoingChain';
import { executeDispatchedRuntimeTask } from './runtimeExecution';
import { enqueueRuntimeTask, registerRuntimeTaskExecutor, waitForSessionTaskEnd } from './runtimeDispatcher';
import { cancelSessionTask } from '../runtime/taskBridge';
import type { RuntimeTask } from '../runtime/api';
import type { Message, ModelConfig } from '../../types';

const model: ModelConfig = { id: 'model', name: 'Mock model', provider: 'custom', apiUrl: 'http://127.0.0.1/v1', modelName: 'mock', isLocal: false, maxTokens: 2000 };
const task = (id: string, extra: Partial<RuntimeTask> = {}): RuntimeTask => ({ id, title: 'Task', kind: 'agent', prompt: 'Summarize the project', status: 'running', steps: [], createdAt: 1, updatedAt: 1, ...extra });
beforeEach(() => {
  vi.restoreAllMocks();
  useChatStore.setState({ sessions: [], currentSessionId: null, activeLeafId: null, loadingSessionIds: new Set(), compressingSessionIds: new Set() });
  useProjectStore.setState({ projects: [], activeProjectId: null });
  useMemoryStore.setState({ memories: [] });
  useKnowledgeStore.setState({ vectorRagEnabled: false, embeddingProvider: 'off' });
  useWorkspaceStore.setState({ rootPath: '' });
  useSettingStore.setState({ locale: 'en' });
  useModelStore.setState({ models: [model], activeModelId: model.id });
  vi.spyOn(window.electron, 'runtimeSaveCheckpoint').mockImplementation(async (input) => task(input.id, { checkpoint: input.checkpoint }));
  vi.spyOn(window.electron, 'runtimeCompleteTask').mockImplementation(async (input) => task(input.id, { status: input.error ? 'failed' : 'completed', result: input.result, error: input.error }));
});

describe('runtime tasks execute through real chat boundaries', () => {
  it.each(['记住：我喜欢简洁的回答', '忘掉全部记忆', '/remember I prefer short replies'])('runs %s as an ordinary model task with its user checkpoint', async prompt => {
    useMemoryStore.getState().addMemory({ content: 'SENTINEL_RETIRED_MEMORY', scope: 'personal', alwaysApply: true });
    const memories = structuredClone(useMemoryStore.getState().memories);
    const run = vi.fn(async (sessionId: string, prior: Message[], user: Message) => {
      const outgoing = await buildOutgoingChain(prior, user, { enabled: false, provider: 'duckduckgo', apiKey: '' }, { sessionId });
      expect(outgoing.chain).toEqual([user]);
      useChatStore.getState().addMessage(sessionId, { id: 'model-answer', role: 'assistant', content: 'Ordinary model reply', parentId: user.id, timestamp: 2, model: model.name });
      useChatStore.getState().clearLoadingForSession(sessionId);
    });
    await executeDispatchedRuntimeTask(task('remember-task', { prompt }), run);
    expect(run).toHaveBeenCalledOnce();
    const session = useChatStore.getState().sessions[0];
    const user = session.messages.find(message => message.role === 'user')!;
    expect(user.content).toBe(prompt);
    expect(useMemoryStore.getState().memories).toEqual(memories);
    expect(session.messages.some(message => message.model === '本地记忆')).toBe(false);
    expect(window.electron.runtimeSaveCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ id: 'remember-task', checkpoint: expect.objectContaining({ userMessageId: user.id }) }));
    expect(window.electron.runtimeCompleteTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'remember-task', error: undefined, result: expect.objectContaining({ content: 'Ordinary model reply' }) }));
  });
  it('reuses the original user turn on retry without injecting retired memories and preserves old results in their branch', async () => {
    const sid = useChatStore.getState().createSession(null);
    useMemoryStore.getState().addMemory({ content: 'SENTINEL_RETIRED_MEMORY', scope: 'personal', alwaysApply: true });
    useMemoryStore.getState().addMemory({ content: 'SENTINEL_RETIRED_PROJECT_MEMORY', scope: 'project', projectId: 'legacy', alwaysApply: true });
    const memories = structuredClone(useMemoryStore.getState().memories);
    useChatStore.getState().addMessage(sid, { id: 'original-user', role: 'user', content: 'Original request', timestamp: 1, model: model.name });
    useChatStore.getState().addMessage(sid, { id: 'old-answer', role: 'assistant', content: 'Partial output', timestamp: 2, model: model.name });
    const run = vi.fn(async (sessionId: string, prior: Message[], user: Message) => {
      expect(user.id).toBe('original-user');
      const outgoing = await buildOutgoingChain(prior, user, { enabled: false, provider: 'duckduckgo', apiKey: '' }, { sessionId });
      expect(outgoing.chain).toEqual([user]);
      const current = useChatStore.getState().sessions.find((s) => s.id === sessionId)!;
      useChatStore.getState().updateMessage(sessionId, current.activeLeafId!, { content: 'Finished output' });
      useChatStore.getState().clearLoadingForSession(sessionId);
    });
    await executeDispatchedRuntimeTask(task('retry-task', { checkpoint: { sessionId: sid, userMessageId: 'original-user', modelId: model.id } }), run);
    const session = useChatStore.getState().sessions[0];
    expect(session.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(session.messages.find((message) => message.id === 'old-answer')?.content).toBe('Partial output');
    expect(session.messages.find((message) => message.id === session.activeLeafId)?.content).toBe('Finished output');
    expect(useMemoryStore.getState().memories).toEqual(memories);
    expect(window.electron.runtimeCompleteTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'retry-task', error: undefined }));
  });

  it('saves a new user checkpoint and waits for streaming completion after the start promise resolves', async () => {
    const run = vi.fn(async (sessionId: string, _prior: Message[], user: Message) => {
      setTimeout(() => {
        useChatStore.getState().addMessage(sessionId, { id: 'new-answer', role: 'assistant', content: 'Final result', parentId: user.id, timestamp: 2, model: model.name });
        useChatStore.getState().clearLoadingForSession(sessionId);
      }, 15);
    });
    let complete = false;
    const work = executeDispatchedRuntimeTask(task('new-task'), run).then(() => { complete = true; });
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(complete).toBe(false);
    await work;
    expect(window.electron.runtimeSaveCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-task', checkpoint: expect.objectContaining({ userMessageId: expect.any(String), modelId: 'model' }) }));
    expect(complete).toBe(true);
    expect(useChatStore.getState().sessions[0].messages.filter((message) => message.role === 'user')).toHaveLength(1);
  });

  it('executes legacy scheduled work as an ordinary background conversation without changing the conversation being read', async () => {
    const foreground = useChatStore.getState().createSession(null);
    useChatStore.getState().addMessage(foreground, { id: 'f', role: 'user', content: 'Unrelated chat', timestamp: 1, model: model.name });
    const pid = useProjectStore.getState().createProject({ name: 'Scheduled project' });
    await executeDispatchedRuntimeTask(task('project-task', { projectId: pid }), async (sid, _prior, user) => {
      expect(useChatStore.getState().sessions.find((s) => s.id === sid)?.projectId).toBeUndefined();
      useChatStore.getState().addMessage(sid, { id: 'result', role: 'assistant', content: 'Project output', parentId: user.id, timestamp: 2, model: model.name });
      useChatStore.getState().clearLoadingForSession(sid);
    });
    expect(useChatStore.getState().currentSessionId).toBe(foreground);
  });

  it('continues missing/mismatched legacy projects in the checkpoint conversation without duplicating the user turn', async () => {
    const sid = useChatStore.getState().createSession();
    useChatStore.setState((state) => ({ sessions: state.sessions.map((session) => ({ ...session, projectId: 'other-deleted-project' })) }));
    useChatStore.getState().addMessage(sid, { id: 'original-user', role: 'user', content: 'Continue my report', timestamp: 1, model: model.name });
    const run = vi.fn(async (sessionId: string, _prior: Message[], user: Message) => {
      expect(sessionId).toBe(sid);
      expect(user.id).toBe('original-user');
      const current = useChatStore.getState().sessions.find((session) => session.id === sessionId)!;
      useChatStore.getState().updateMessage(sessionId, current.activeLeafId!, { content: 'Continued report' });
      useChatStore.getState().clearLoadingForSession(sessionId);
    });
    await executeDispatchedRuntimeTask(task('missing-project', { projectId: 'deleted-project', checkpoint: { sessionId: sid, userMessageId: 'original-user' } }), run);
    expect(run).toHaveBeenCalledOnce();
    expect(useChatStore.getState().sessions[0].messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(useChatStore.getState().sessions[0].projectId).toBe('other-deleted-project');
  });

  it('queues dispatches while foreground work is busy and runs tasks serially with deduplication', async () => {
    const foreground = useChatStore.getState().createSession(null);
    useChatStore.getState().setLoadingSession(foreground);
    const calls: string[] = [];
    let release: (() => void) | undefined;
    const firstComplete = new Promise<void>((resolve) => { release = resolve; });
    const unregister = registerRuntimeTaskExecutor(async (queued) => { calls.push(queued.id); if (queued.id === 'queued-one') await firstComplete; }, () => {});
    enqueueRuntimeTask(task('queued-one'));
    enqueueRuntimeTask(task('queued-one'));
    enqueueRuntimeTask(task('queued-two'));
    expect(calls).toEqual([]);
    useChatStore.getState().clearLoadingForSession(foreground);
    await Promise.resolve();
    expect(calls).toEqual(['queued-one']);
    release!();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(calls).toEqual(['queued-one', 'queued-two']);
    unregister();
  });

  it('a cancelled pending stream clears the terminal wait without recording success', async () => {
    const sid = useChatStore.getState().createSession(null);
    useChatStore.getState().setLoadingSession(sid);
    const done = waitForSessionTaskEnd(sid);
    await cancelSessionTask(sid);
    useChatStore.getState().clearLoadingForSession(sid);
    await done;
    expect(window.electron.runtimeCompleteTask).not.toHaveBeenCalled();
  });
});
