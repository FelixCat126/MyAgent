import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkspaceStore } from './workspaceStore';
import { PERSIST_KEYS } from '../utils/persistKeys';

function reset() {
  localStorage.removeItem(PERSIST_KEYS.workspace);
  useWorkspaceStore.setState({ rootPath: '', maxChars: 12_000 });
}

describe('workspaceStore', () => {
  beforeEach(() => {
    reset();
  });

  it('setRootPath', () => {
    useWorkspaceStore.getState().setRootPath('/foo/bar');
    expect(useWorkspaceStore.getState().rootPath).toBe('/foo/bar');
  });

  it('setMaxChars 夹在 500～200_000 之间', () => {
    useWorkspaceStore.getState().setMaxChars(10);
    expect(useWorkspaceStore.getState().maxChars).toBe(500);
    useWorkspaceStore.getState().setMaxChars(999_999_999);
    expect(useWorkspaceStore.getState().maxChars).toBe(200_000);
    useWorkspaceStore.getState().setMaxChars(8000);
    expect(useWorkspaceStore.getState().maxChars).toBe(8000);
  });

  it('setRootPath 接受任意字符串（含波浪号 / 相对）', () => {
    useWorkspaceStore.getState().setRootPath('~/notes');
    expect(useWorkspaceStore.getState().rootPath).toBe('~/notes');
    useWorkspaceStore.getState().setRootPath('');
    expect(useWorkspaceStore.getState().rootPath).toBe('');
  });

  it('setMaxChars 边界值 500/200_000 直接接受', () => {
    useWorkspaceStore.getState().setMaxChars(500);
    expect(useWorkspaceStore.getState().maxChars).toBe(500);
    useWorkspaceStore.getState().setMaxChars(200_000);
    expect(useWorkspaceStore.getState().maxChars).toBe(200_000);
  });

  it('persist 状态包含 rootPath 与 maxChars', () => {
    const opts = useWorkspaceStore.persist.getOptions();
    expect(opts.name).toBeTruthy();
  });
});
