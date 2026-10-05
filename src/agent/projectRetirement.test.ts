import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, ModelConfig } from '../types';
import type { RuntimeTask } from '../features/runtime/api';

const checkpoint = vi.hoisted(() => ({ task: undefined as RuntimeTask | undefined }));
vi.mock('../features/runtime/taskBridge', () => ({ sessionTask: () => checkpoint.task, saveSessionCheckpoint: vi.fn(async () => {}) }));
vi.mock('./callModelAgentRound', () => ({ callModelAgentRound: vi.fn() }));
vi.mock('./tools/durableTools', () => ({ executeDurableToolBatch: vi.fn() }));
vi.mock('./tools/localTools', async (load) => ({ ...await load<typeof import('./tools/localTools')>(), executeAgentLocalTool: vi.fn(async () => '无相关文件') }));

import { runAgentLoop } from './agentRunner';
import { callModelAgentRound } from './callModelAgentRound';
import { executeDurableToolBatch } from './tools/durableTools';
import { useProjectStore } from '../store/projectStore';
import { useChatStore } from '../store/chatStore';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useKnowledgeStore } from '../store/knowledgeStore';
import { useSettingStore } from '../store/settingStore';

const model: ModelConfig = { id: 'model', name: 'fixture', provider: 'custom', apiUrl: 'https://fixture.invalid', modelName: 'fixture', isLocal: false };
const user: Message = { id: 'user', role: 'user', content: '分析上传附件中的数据', timestamp: 1, model: model.name, files: [{ name: 'source.csv', path: '/uploads/source.csv', type: 'text/csv', size: 8 }] };

beforeEach(() => {
  vi.clearAllMocks();
  checkpoint.task = undefined;
  useProjectStore.setState({ projects: [{ id: 'legacy', name: 'Old project', rootPath: '/legacy-project', rules: 'LEGACY_SECRET_RULE', description: '', createdAt: 1, updatedAt: 1 }], activeProjectId: 'legacy' });
  useChatStore.setState({ sessions: [{ id: 'chat', title: 'Old chat', messages: [user], projectId: 'legacy', createdAt: 1, updatedAt: 1 }], currentSessionId: 'chat' });
  useWorkspaceStore.setState({ rootPath: '/ordinary-directory' });
  useKnowledgeStore.setState({ embeddingProvider: 'off', vectorRagEnabled: false });
  useSettingStore.setState({ agentLocalToolsEnabled: true, agentBrowserEnabled: false, agentDeniedPaths: ['/restricted'] });
  vi.mocked(callModelAgentRound).mockReset();
  vi.mocked(callModelAgentRound).mockResolvedValueOnce({ content: '{"myagent_tool":"local_read","path":"/uploads/source.csv"}' }).mockResolvedValue({ content: '上传附件中的数据已分析，共有 3 行数据。' });
  vi.mocked(executeDurableToolBatch).mockResolvedValue({ resultText: '文件中的真实数据，共有3行', exportFiles: [], attachFiles: [], skippedDuplicate: 0 });
  vi.spyOn(window.electron, 'runtimeGetState').mockResolvedValue({ tasks: [], schedules: [], connections: [] });
});

describe('ordinary agent execution after project retirement', () => {
  it('uses the ordinary directory and preserves upload authorization while continuing a legacy checkpoint', async () => {
    const oldRules: Message = { id: 'personal-ctx-1', role: 'system', content: 'LEGACY_SECRET_RULE', model: 'myagent-personal-context', timestamp: 1 };
    const oldRoot: Message = { id: 'agent-sys-1', role: 'system', content: 'Read files in /legacy-project', model: 'agent-capability', timestamp: 1 };
    const completed: Message = { id: 'completed', role: 'system', content: '已完成的计算结果 33 元', model: 'agent-tool', timestamp: 1 };
    checkpoint.task = { id: 'task', title: 'Resume', kind: 'agent', status: 'running', projectId: 'legacy', steps: [], createdAt: 1, updatedAt: 1, checkpoint: { agentState: { messages: [oldRules, oldRoot, user, completed], executed: [] } } };
    await runAgentLoop({ chatSessionId: 'chat', chainMessages: [user], userText: user.content, model, locale: 'zh' });
    const messages = vi.mocked(callModelAgentRound).mock.calls[0][0];
    const instructions = messages.map((entry) => entry.content).join('\n');
    expect(instructions).toContain('/ordinary-directory');
    expect(instructions).not.toContain('/legacy-project');
    expect(instructions).not.toContain('LEGACY_SECRET_RULE');
    expect(messages).toContain(completed);
    expect(messages).toContain(user);
    expect(vi.mocked(executeDurableToolBatch).mock.calls[0][2]).toMatchObject({ workspaceRoot: '/ordinary-directory', deniedPaths: ['/restricted'], attachmentPaths: ['/uploads/source.csv'] });
    expect(vi.mocked(executeDurableToolBatch).mock.calls[0][2]).not.toHaveProperty('scopeRoot');
    expect(checkpoint.task?.checkpoint?.agentState).toMatchObject({ messages: [oldRules, oldRoot, user, completed] });
  });
});
