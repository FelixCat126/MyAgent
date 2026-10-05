import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentWorkbenchPanel } from './DocumentWorkbenchPanel';
import { openDocumentWorkbench } from './events';
import type { WorkbenchDocument } from './types';
const file = { path: '/fixture/report.md', name: 'report.md', type: 'text/markdown', size: 12 };
const original: WorkbenchDocument = { id: 'doc', sourcePath: file.path, sourceMissing: false, title: file.name, kind: 'md', content: '# Original', editable: true, activeVersionId: 'v1', versions: [{ id: 'v1', createdAt: 1, label: 'Original', format: 'md', file, content: '# Original' }] };
afterEach(cleanup);
describe('document workbench UI', () => {
  it('opens from attachment events, edits and saves a new version, then previews its body', async () => {
    const inspect = vi.spyOn(window.electron, 'inspectDocument').mockResolvedValue({ ok: true, document: original });
    const save = vi.spyOn(window.electron, 'saveDocumentVersion').mockResolvedValue({ ok: true, document: { ...original, content: '# Updated', activeVersionId: 'v2', versions: [...original.versions, { ...original.versions[0], id: 'v2', label: 'Version 2', content: '# Updated' }] }, files: [file] });
    render(<DocumentWorkbenchPanel />); act(() => openDocumentWorkbench(file)); await screen.findByText('Original'); fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByRole('textbox', { name: '文档正文' }), { target: { value: '# Updated' } }); fireEvent.click(screen.getByRole('button', { name: '保存新版本' }));
    await screen.findByText('Updated'); expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ path: file.path })); expect(save).toHaveBeenCalledWith(expect.objectContaining({ documentId: 'doc', baseVersionId: 'v1', content: '# Updated' }));
    inspect.mockRestore(); save.mockRestore();
  });
  it('cancels an in-flight read and reports a deleted source clearly', async () => {
    const inspect = vi.spyOn(window.electron, 'inspectDocument').mockImplementationOnce(() => new Promise(() => {})); const cancel = vi.spyOn(window.electron, 'cancelDocumentOperation');
    render(<DocumentWorkbenchPanel />); act(() => openDocumentWorkbench(file)); await screen.findByRole('button', { name: '取消' }); fireEvent.click(screen.getByRole('button', { name: '取消' })); expect(cancel).toHaveBeenCalledWith(expect.any(String));
    inspect.mockResolvedValue({ ok: true, document: { ...original, sourceMissing: true } }); act(() => openDocumentWorkbench(file)); await screen.findByText('源文件已删除；此处读取保留的版本快照。'); await waitFor(() => expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument());
    inspect.mockRestore(); cancel.mockRestore();
  });
  it('prevents editing during a save and ignores its late result after another document opens', async () => {
    const second = { ...original, id: 'second', title: 'second.md', content: '# Second', sourcePath: '/fixture/second.md' };
    const inspect = vi.spyOn(window.electron, 'inspectDocument').mockResolvedValueOnce({ ok: true, document: original }).mockResolvedValue({ ok: true, document: second });
    let resolveSave!: (value: Awaited<ReturnType<typeof window.electron.saveDocumentVersion>>) => void;
    const save = vi.spyOn(window.electron, 'saveDocumentVersion').mockImplementation(() => new Promise(resolve => { resolveSave = resolve; }));
    render(<DocumentWorkbenchPanel />); act(() => openDocumentWorkbench(file)); await screen.findByText('Original'); fireEvent.click(screen.getByRole('button', { name: '编辑' })); fireEvent.change(screen.getByRole('textbox', { name: '文档正文' }), { target: { value: '# Updated' } }); fireEvent.click(screen.getByRole('button', { name: '保存新版本' }));
    expect(screen.getByRole('textbox', { name: '文档正文' })).toBeDisabled();
    act(() => openDocumentWorkbench({ ...file, path: second.sourcePath, name: second.title })); await screen.findByText('Second');
    await act(async () => resolveSave({ ok: true, document: { ...original, content: '# Late update' }, files: [file] })); expect(screen.queryByText('Late update')).not.toBeInTheDocument(); expect(screen.getByText('Second')).toBeInTheDocument();
    inspect.mockRestore(); save.mockRestore();
  });
});
