import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgentLocalToolBatch } from './localTools';
import { useSettingStore } from '../../store/settingStore';
import type { AgentToolCall } from '../parseAgentTools';

beforeEach(() => {
  useSettingStore.setState({ agentLocalToolsEnabled: true, agentBrowserEnabled: true });
});

describe('runAgentLocalToolBatch', () => {
  it('returns invalid JSON-fallback arguments to the model instead of throwing', async () => {
    const calls: AgentToolCall[] = [
      { tool: 'local_list', subpath: '~/Documents', maxDepth: 6, raw: '{}' },
      { tool: 'web_read', maxChars: 50, raw: '{}' },
    ];
    const out = await runAgentLocalToolBatch(calls, { deniedPaths: [], workspaceRoot: '' }, null, new Map());
    expect(out.outcomes).toHaveLength(2);
    expect(out.outcomes.every((o) => o.isError && o.text.includes('参数无效'))).toBe(true);
    expect(out.notExecuted).toBe(2);
  });

  it('refuses web tools when another session holds the browser lock', async () => {
    const acquire = vi.fn(() => '另一个会话正在使用内嵌浏览器');
    const out = await runAgentLocalToolBatch([{ tool: 'web_open', url: 'example.com', raw: '{}' }], { deniedPaths: [], workspaceRoot: '', acquireBrowserLock: acquire }, null, new Map());
    expect(acquire).toHaveBeenCalledOnce();
    expect(out.outcomes[0]).toMatchObject({ isError: true });
    expect(out.outcomes[0].text).toContain('另一个会话');
  });

  it('does not cache failed local results as completed duplicates', async () => {
    vi.spyOn(window.electron, 'agentLocalRead').mockResolvedValue({ ok: false, error: '暂时不可读' } as never);
    const executed = new Map<string, string>();
    const call: AgentToolCall = { tool: 'local_read', path: '/a.txt', raw: '{}' };
    await runAgentLocalToolBatch([call], { deniedPaths: [], workspaceRoot: '' }, null, executed);
    expect(executed.size).toBe(0);
  });
});
