import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkspaceStore } from './workspaceStore';

function reset() {
  localStorage.removeItem('workspace-storage');
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
});
