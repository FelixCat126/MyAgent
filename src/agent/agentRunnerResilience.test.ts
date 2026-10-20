import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, ModelConfig } from '../types';

vi.mock('../features/runtime/taskBridge', () => ({ sessionTask: () => undefined, saveSessionCheckpoint: vi.fn(async () => {}) }));
vi.mock('./callModelAgentRound', () => ({ callModelAgentRound: vi.fn() }));
vi.mock('./tools/durableTools', () => ({ executeDurableToolBatch: vi.fn() }));
vi.mock('./tools/localTools', async (load) => ({ ...await load<typeof import('./tools/localTools')>(), executeAgentLocalTool: vi.fn(async () => '无相关文件') }));

import { runAgentLoop } from './agentRunner';
import { callModelAgentRound } from './callModelAgentRound';
import { executeDurableToolBatch } from './tools/durableTools';
import { useSettingStore } from '../store/settingStore';
import { useKnowledgeStore } from '../store/knowledgeStore';

const model: ModelConfig = { id: 'model', name: 'fixture', provider: 'custom', apiUrl: 'https://fixture.invalid', modelName: 'fixture', isLocal: false };
const user: Message = { id: 'user', role: 'user', content: '你好，帮我总结一下', timestamp: 1, model: model.name };

beforeEach(() => {
  vi.clearAllMocks();
  useKnowledgeStore.setState({ embeddingProvider: 'off', vectorRagEnabled: false });
  useSettingStore.setState({ agentLocalToolsEnabled: true, agentBrowserEnabled: false, agentDeniedPaths: [] });
  vi.mocked(callModelAgentRound).mockReset();
});

describe('agent loop resilience', () => {
  it('still answers when listing tools of a stale MCP connection fails', async () => {
    vi.spyOn(window.electron, 'runtimeGetState').mockResolvedValue({ tasks: [], schedules: [], connections: [{ id: 'dead', name: 'Dead', transport: 'stdio', enabled: true, status: 'connected' }] });
    vi.spyOn(window.electron, 'runtimeListTools').mockRejectedValue(new Error('MCP 尚未连接'));
    vi.mocked(callModelAgentRound).mockResolvedValue({ content: '这是总结。' });
    const out = await runAgentLoop({ chatSessionId: 'chat', chainMessages: [user], userText: user.content, model, locale: 'zh' });
    expect(out.displayText).toBe('这是总结。');
  });

  it('maps native tool results one-to-one and flags failed calls', async () => {
    vi.spyOn(window.electron, 'runtimeGetState').mockResolvedValue({ tasks: [], schedules: [], connections: [] });
    vi.mocked(callModelAgentRound)
      .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'a', name: 'local_read', arguments: { path: '/a.txt' } }, { id: 'b', name: 'local_read', arguments: { path: '/b.txt' } }] })
      .mockResolvedValue({ content: '完成' });
    vi.mocked(executeDurableToolBatch).mockResolvedValue({ resultText: 'A 内容\n\n【local_read】\n错误：不存在', exportFiles: [], attachFiles: [], skippedDuplicate: 0, outcomes: [{ text: 'A 内容', isError: false }, { text: '【local_read】\n错误：不存在', isError: true }], notExecuted: 0 });
    await runAgentLoop({ chatSessionId: 'chat', chainMessages: [user], userText: user.content, model, locale: 'zh' });
    const second = vi.mocked(callModelAgentRound).mock.calls[1][0];
    const toolMessage = second.find((m) => m.nativeToolResults?.length);
    expect(toolMessage?.nativeToolResults).toEqual([{ id: 'a', content: 'A 内容' }, { id: 'b', content: '【local_read】\n错误：不存在', isError: true }]);
  });
});
