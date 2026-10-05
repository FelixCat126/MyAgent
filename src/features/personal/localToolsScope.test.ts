import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeAgentLocalTool, findLocalImagesByKeyword } from '../../agent/tools/localTools';
import { useSettingStore } from '../../store/settingStore';

describe('explicit directory scope travels through every local file tool', () => {
  beforeEach(() => { vi.restoreAllMocks(); useSettingStore.setState({ agentLocalToolsEnabled: true }); });
  it('uses explicitly scoped roots for filename, image, list and read requests', async () => {
    const find = vi.spyOn(window.electron, 'agentLocalFindByName').mockResolvedValue({ ok: true, matches: [] });
    const list = vi.spyOn(window.electron, 'agentLocalList').mockResolvedValue({ ok: true, entries: [] });
    const read = vi.spyOn(window.electron, 'agentLocalRead').mockResolvedValue({ ok: true, text: 'content' });
    const ctx = { workspaceRoot: '/project', scopeRoot: '/project', deniedPaths: ['/private'] };
    await executeAgentLocalTool({ tool: 'local_search', query: 'report', mode: 'filename', raw: '' }, ctx, null);
    await findLocalImagesByKeyword('photo', ctx, 1);
    await executeAgentLocalTool({ tool: 'local_list', raw: '' }, ctx, null);
    await executeAgentLocalTool({ tool: 'local_read', path: 'report.md', raw: '' }, ctx, null);
    expect(find.mock.calls.every(([argument]) => argument.root === '/project' && argument.scoped === true)).toBe(true);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ root: '/project', scoped: true }));
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ root: '/project', scoped: true }));
  });
  it('rejects an empty explicit scope before issuing file IPC and preserves ordinary access', async () => {
    const find = vi.spyOn(window.electron, 'agentLocalFindByName').mockResolvedValue({ ok: true, matches: [] });
    const ctx = { workspaceRoot: '', scopeRoot: '', deniedPaths: [] };
    expect(await executeAgentLocalTool({ tool: 'local_search', query: 'report', raw: '' }, ctx, null)).toContain('尚未授权');
    expect(find).not.toHaveBeenCalled();
    await executeAgentLocalTool({ tool: 'local_search', query: 'report', mode: 'filename', raw: '' }, { workspaceRoot: '', deniedPaths: [] }, null);
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ scoped: false }));
  });
});
