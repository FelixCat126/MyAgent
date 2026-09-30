import { describe, it, expect, vi } from 'vitest';
import { generateDocumentArtifacts } from './documentArtifacts';
import { previousDocumentBody, unsupportedDocumentRequest } from '../utils/documentExportIntent';
import type { Message } from '../types';
describe('document delivery', () => {
  it('keeps partial success and retries only missing formats', async () => {
    const call = vi.spyOn(window.electron, 'createDocumentArtifact');
    call.mockResolvedValueOnce({ ok: true, file: { path: '/tmp/report.docx', name: 'report.docx', size: 100, type: 'document' } }).mockResolvedValueOnce({ ok: false, error: 'PDF failure' });
    const first = await generateDocumentArtifacts('正文', ['docx', 'pdf'], 'report');
    expect(first.files).toHaveLength(1); expect(first.errors).toEqual(['PDF: PDF failure']);
    call.mockResolvedValueOnce({ ok: true, file: { path: '/tmp/report.pdf', name: 'report.pdf', size: 100, type: 'application/pdf' } });
    const retry = await generateDocumentArtifacts('正文', ['docx', 'pdf'], 'report', first.files);
    expect(retry.files).toHaveLength(2); expect(call).toHaveBeenCalledTimes(3); call.mockRestore();
  });
  it('does not generate after cancellation', async () => {
    const call = vi.spyOn(window.electron, 'createDocumentArtifact');
    expect((await generateDocumentArtifacts('正文', ['pdf'], 'report', [], () => true)).cancelled).toBe(true);
    expect(call).not.toHaveBeenCalled(); call.mockRestore();
  });
  it('converts original body without feeding the success banner to the renderer', () => {
    const history = [{ role: 'assistant', content: '文件已生成', exportHint: { sourceContent: '# 正文\n\n完整数据' } }] as Message[];
    expect(previousDocumentBody('把刚才那个改成 PDF', history)).toBe('# 正文\n\n完整数据');
    expect(previousDocumentBody('把刚才那个修改后导出 PDF', history)).toBeUndefined();
    expect(unsupportedDocumentRequest('生成 PPT 文件')).toBe(true);
    expect(unsupportedDocumentRequest('解释如何制作 PPT')).toBe(false);
  });
});

it('keeps truncated model output visible without creating a misleading finished attachment', async () => {
  const { runSyncReplyPath } = await import('./runSyncReplyPath');
  const api = vi.spyOn(window.electron, 'callModel').mockResolvedValue({ content: '# 未完成的正文', truncated: true });
  const artifact = vi.spyOn(window.electron, 'createDocumentArtifact');
  const ui = { t: (key: string) => key, addMessage: vi.fn(), updateMessage: vi.fn(), clearLoadingForSession: vi.fn() };
  await runSyncReplyPath({ ui, sendSessionId: 'truncated-test', historyBeforeUser: [], userMessage: { id: 'u', content: '生成PDF' }, activeModel: { name: 'test' }, plainMessages: [], plainModel: {}, exportHint: { document: true, formats: ['pdf'] } } as unknown as Parameters<typeof runSyncReplyPath>[0]);
  expect(artifact).not.toHaveBeenCalled();
  expect(ui.updateMessage).toHaveBeenLastCalledWith('truncated-test', expect.any(String), expect.objectContaining({ content: '# 未完成的正文', exportHint: expect.objectContaining({ status: 'failed' }) }));
  api.mockRestore(); artifact.mockRestore();
});
