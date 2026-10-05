import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeStep, RuntimeTask } from '../../features/runtime/api';
import type { FileInfo } from '../../types';
import type { AgentToolCall } from '../parseAgentTools';
import type { AgentLocalToolContext } from './localTools';

const state = vi.hoisted(() => ({ task: undefined as RuntimeTask | undefined }));
vi.mock('../../features/runtime/taskBridge', () => ({ sessionTask: vi.fn(() => state.task) }));
vi.mock('./localTools', () => ({ runAgentLocalToolBatch: vi.fn() }));
import { runAgentLocalToolBatch } from './localTools';
import { executeDurableToolBatch } from './durableTools';

const ctx: AgentLocalToolContext = { workspaceRoot: '/project', scopeRoot: '/project', deniedPaths: [] };
const exported: FileInfo = { path: '/generated/report.xlsx', name: 'report.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 20 };
const attached: FileInfo = { path: '/project/photo.png', name: 'photo.png', type: 'image/png', size: 10 };
const result = { resultText: '已生成真实文件', exportFiles: [exported], attachFiles: [attached], skippedDuplicate: 0 };
const exportCall = (content = '报告正文'): AgentToolCall => ({ tool: 'local_export', name: 'report', format: 'xlsx', content, raw: JSON.stringify({ content }) });
const mcpCall: AgentToolCall = { tool: 'mcp_call', connectionId: 'connection', name: 'create_record', args: { title: 'important' }, raw: '{}' };
let persistedSteps: RuntimeStep[] = [];

beforeEach(() => {
  vi.restoreAllMocks(); vi.mocked(runAgentLocalToolBatch).mockReset();
  state.task = { id: 'task', title: 'Task', status: 'running', kind: 'agent', createdAt: 1, updatedAt: 1, steps: [] };
  persistedSteps = [];
  vi.mocked(runAgentLocalToolBatch).mockResolvedValue(result);
  vi.spyOn(window.electron, 'runtimeRecordStep').mockImplementation(async ({ key, title, status, result: value, error }) => {
    const step: RuntimeStep = { key, title, status, result: value, error, updatedAt: Date.now() };
    persistedSteps = [...persistedSteps.filter((entry) => entry.key !== key), step];
    return { ...state.task!, steps: [...persistedSteps] };
  });
});

describe('durable agent tool execution', () => {
  it('replays a persisted completed result with both download and display attachments, without re-executing', async () => {
    const first = await executeDurableToolBatch('session', [exportCall()], ctx, null, new Map());
    expect(first).toMatchObject({ exportFiles: [exported], attachFiles: [attached], skippedDuplicate: 0 });
    expect(persistedSteps[0].status).toBe('completed');
    state.task = { ...state.task!, steps: structuredClone(persistedSteps) }; // Renderer restart / task recovery.
    vi.mocked(runAgentLocalToolBatch).mockClear(); vi.mocked(window.electron.runtimeRecordStep).mockClear();
    const executed = new Map<string, string>();
    const recovered = await executeDurableToolBatch('session', [exportCall()], ctx, null, executed);
    expect(recovered).toMatchObject({ resultText: '已生成真实文件', exportFiles: [exported], attachFiles: [attached], skippedDuplicate: 1 });
    expect([...executed.values()]).toEqual(['已生成真实文件']);
    expect(runAgentLocalToolBatch).not.toHaveBeenCalled();
    expect(window.electron.runtimeRecordStep).not.toHaveBeenCalled();
  });

  it('treats changed middle content as a distinct export even when name, length, beginning and end match', async () => {
    const prefix = 'BEGIN' + 'a'.repeat(1200), suffix = 'z'.repeat(1200) + 'END';
    const original = exportCall(`${prefix}Original${suffix}`), revised = exportCall(`${prefix}Revision${suffix}`);
    expect(original.tool === 'local_export' && revised.tool === 'local_export' && original.content.length === revised.content.length).toBe(true);
    await executeDurableToolBatch('session', [original], ctx, null, new Map());
    await executeDurableToolBatch('session', [revised], ctx, null, new Map());
    expect(runAgentLocalToolBatch).toHaveBeenCalledTimes(2);
    expect(persistedSteps).toHaveLength(2);
    expect(persistedSteps[0].key).not.toBe(persistedSteps[1].key);
  });

  it.each(['interrupted', 'running'] as const)('never reissues an MCP write whose persisted state is %s', async (status) => {
    await executeDurableToolBatch('session', [mcpCall], ctx, null, new Map());
    state.task!.steps = [{ ...persistedSteps[0], status, result: undefined }];
    vi.mocked(runAgentLocalToolBatch).mockClear(); vi.mocked(window.electron.runtimeRecordStep).mockClear();
    await expect(executeDurableToolBatch('session', [mcpCall], ctx, null, new Map())).rejects.toThrow('避免重复写入');
    expect(runAgentLocalToolBatch).not.toHaveBeenCalled();
    expect(window.electron.runtimeRecordStep).not.toHaveBeenCalled();
  });

  it('records thrown MCP transport errors as interrupted rather than retryable failures', async () => {
    vi.mocked(runAgentLocalToolBatch).mockRejectedValueOnce(new Error('connection lost after send'));
    await expect(executeDurableToolBatch('session', [mcpCall], ctx, null, new Map())).rejects.toThrow('connection lost');
    expect(persistedSteps[0]).toMatchObject({ status: 'interrupted', error: 'connection lost after send' });
    state.task = { ...state.task!, steps: [...persistedSteps] };
    await expect(executeDurableToolBatch('session', [mcpCall], ctx, null, new Map())).rejects.toThrow('避免重复写入');
    expect(runAgentLocalToolBatch).toHaveBeenCalledTimes(1);
  });

  it('also blocks an immediate in-process retry after an ambiguous MCP throw', async () => {
    vi.mocked(runAgentLocalToolBatch).mockRejectedValueOnce(new Error('result lost'));
    await expect(executeDurableToolBatch('session', [mcpCall], ctx, null, new Map())).rejects.toThrow('result lost');
    await expect(executeDurableToolBatch('session', [mcpCall], ctx, null, new Map())).rejects.toThrow('避免重复写入');
    expect(runAgentLocalToolBatch).toHaveBeenCalledTimes(1);
  });

  it('blocks ambiguous MCP failures returned through IPC, where the main process catches transport errors', async () => {
    vi.mocked(runAgentLocalToolBatch).mockResolvedValueOnce({ resultText: '错误：MCP response lost after send', exportFiles: [], attachFiles: [], skippedDuplicate: 0 });
    await executeDurableToolBatch('session', [mcpCall], ctx, null, new Map());
    expect(persistedSteps[0].status).toBe('interrupted');
    await expect(executeDurableToolBatch('session', [mcpCall], ctx, null, new Map())).rejects.toThrow('避免重复写入');
    expect(runAgentLocalToolBatch).toHaveBeenCalledTimes(1);
  });

  it('does not cache a reported local tool error as completed output', async () => {
    const executed = new Map<string, string>();
    vi.mocked(runAgentLocalToolBatch).mockResolvedValueOnce({ resultText: '错误：写入失败', exportFiles: [], attachFiles: [], skippedDuplicate: 0 });
    await executeDurableToolBatch('session', [exportCall()], ctx, null, executed);
    expect(persistedSteps[0].status).toBe('failed');
    const recovered = await executeDurableToolBatch('session', [exportCall()], ctx, null, new Map());
    expect(recovered.exportFiles).toEqual([exported]);
    expect(runAgentLocalToolBatch).toHaveBeenCalledTimes(2);
  });
});
