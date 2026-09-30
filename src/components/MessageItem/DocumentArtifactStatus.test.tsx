import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { DocumentArtifactStatus } from './DocumentArtifactStatus';
import { useChatStore } from '../../store/chatStore';
import { flushZustandFilePersist } from '../../utils/zustandFileStorage';
import type { Message } from '../../types';
afterEach(async () => { cleanup(); await flushZustandFilePersist(); vi.restoreAllMocks(); });
it('renders a retry action, preserves successful attachments and writes the new file to the message', async () => {
  const message: Message = { id: 'doc-retry', role: 'assistant', content: '# 正文', timestamp: 1, model: 'test', exportHint: { document: true, status: 'failed', formats: ['docx', 'pdf'], sourceContent: '# 正文', error: 'PDF error' }, files: [{ name: 'a.docx', path: '/a.docx', size: 100, type: 'application/docx' }] };
  const sessionId = useChatStore.getState().createSession('test');
  useChatStore.getState().addMessage(sessionId, message);
  const api = vi.spyOn(window.electron, 'createDocumentArtifact').mockResolvedValue({ ok: true, file: { name: 'a.pdf', path: '/a.pdf', size: 100, type: 'application/pdf' } });
  render(<DocumentArtifactStatus message={message} />);
  fireEvent.click(screen.getByRole('button', { name: '重试缺失的文件' }));
  await waitFor(() => expect(useChatStore.getState().sessions.find(s => s.id === sessionId)?.messages.find(m => m.id === message.id)?.exportHint?.status).toBe('ready'));
  expect(api).toHaveBeenCalledTimes(1); expect(api.mock.calls[0][0].format).toBe('pdf');
});

it('shows one primary file card, omits the duplicate format and converts from the retained full body', async () => {
  const { default: MessageItem } = await import('../MessageItem');
  const body = '# 完整报告\n\n正文\n\n```js\nconst a = 1;\n```\n\n必须保留的结尾';
  const message: Message = { id: 'download-ready', role: 'assistant', content: '文件已生成', timestamp: 1, model: 'test', exportHint: { document: true, status: 'ready', formats: ['pdf'], sourceContent: body }, files: [{ name: 'report.pdf', path: '/report.pdf', size: 100, type: 'application/pdf' }] };
  const download = vi.spyOn(window.electron, 'saveLocalFileCopy').mockResolvedValue({ ok: true, path: '/saved.pdf' });
  const save = vi.spyOn(window.electron, 'saveAssistantExport').mockResolvedValue({ ok: true, path: '/saved.pdf' });
  render(<MessageItem message={message} />);
  expect(screen.queryByText('文件已生成')).toBeNull();
  expect(screen.queryByRole('button', { name: 'PDF' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '下载 report.pdf' }));
  await waitFor(() => expect(download).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: 'Word' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ format: 'docx', content: body })));
});
