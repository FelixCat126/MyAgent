import { act, renderHook } from '@testing-library/react';
import { useLayoutEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSessionComposerDrafts } from './useSessionComposerDrafts';

function useComposer(sessionId: string | null, preparedPrompt?: string) {
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const drafts = useSessionComposerDrafts({ sessionId, input, files, setInput, setFiles, setPreviews });
  useLayoutEffect(() => { if (preparedPrompt) setInput(preparedPrompt); }, [sessionId, preparedPrompt]);
  return { input, files, previews, setInput, setFiles, drafts };
}

afterEach(() => vi.restoreAllMocks());

describe('conversation composer drafts', () => {
  it('preserves unsent text and original attachments across project/conversation switches', () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:restored-image');
    const image = new File(['pixels'], 'image.png', { type: 'image/png' });
    const document = new File(['report'], 'report.txt', { type: 'text/plain' });
    const { result, rerender } = renderHook(({ sid }) => useComposer(sid), { initialProps: { sid: 'project-a' } });
    act(() => { result.current.setInput('未发送的项目 A 请求'); result.current.setFiles([image, document]); });
    rerender({ sid: 'project-b' });
    expect(result.current.input).toBe('');
    expect(result.current.files).toEqual([]);
    act(() => { result.current.setInput('项目 B 草稿'); });
    rerender({ sid: 'project-a' });
    expect(result.current.input).toBe('未发送的项目 A 请求');
    expect(result.current.files).toEqual([image, document]);
    expect(result.current.previews).toEqual({ 'image.png': 'blob:restored-image' });
    rerender({ sid: 'project-b' });
    expect(result.current.input).toBe('项目 B 草稿');
  });

  it('does not wipe the visible draft when an upload completes for a background conversation', () => {
    const { result, rerender } = renderHook(({ sid }) => useComposer(sid), { initialProps: { sid: 'sending' } });
    act(() => { result.current.setInput('正在上传附件的原请求'); });
    rerender({ sid: 'new-current' });
    act(() => { result.current.setInput('当前仍在写的新请求'); result.current.drafts.clearDraft('sending'); });
    expect(result.current.input).toBe('当前仍在写的新请求');
    rerender({ sid: 'sending' });
    expect(result.current.input).toBe('');
    rerender({ sid: 'new-current' });
    expect(result.current.input).toBe('当前仍在写的新请求');
  });

  it('fills a recipe into its new conversation and restores the previous unsent draft later', () => {
    const { result, rerender } = renderHook(({ sid, prompt }) => useComposer(sid, prompt), { initialProps: { sid: 'original', prompt: undefined as string | undefined } });
    act(() => { result.current.setInput('原来的待发送内容'); });
    rerender({ sid: 'recipe', prompt: '分析本周数据并生成 Excel 文件' });
    expect(result.current.input).toBe('分析本周数据并生成 Excel 文件');
    rerender({ sid: 'original', prompt: undefined });
    expect(result.current.input).toBe('原来的待发送内容');
    rerender({ sid: 'recipe', prompt: undefined });
    expect(result.current.input).toBe('分析本周数据并生成 Excel 文件');
  });
});
