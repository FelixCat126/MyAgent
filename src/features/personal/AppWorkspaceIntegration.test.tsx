import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import { useChatStore } from '../../store/chatStore';
import { useSettingStore } from '../../store/settingStore';
import { useModelStore } from '../../store/modelStore';
import { openDocumentWorkbench } from '../documents/events';
import { ImagePreviewModal } from '../../components/MessageItem/ImagePreviewModal';
import { PERSIST_KEYS } from '../../utils/persistKeys';

beforeEach(() => {
  localStorage.setItem(PERSIST_KEYS.onboarding, '1');
  useChatStore.setState({ sessions: [], currentSessionId: null, activeLeafId: null, loadingSessionIds: new Set(), compressingSessionIds: new Set() });
  useSettingStore.setState({ locale: 'zh', theme: 'light', gestureControlEnabled: false, particleFieldEnabled: false, voiceReplyEnabled: false, voiceWakeEnabled: false });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('simplified App shell and retained task integration', () => {
  it('shows one accessible task icon and keeps task controls, close and Escape working', async () => {
    useChatStore.getState().createSession(null);
    render(<App />);
    const entry = screen.getByRole('button', { name: '任务中心' });
    expect(entry).toHaveAttribute('title', '任务中心');
    expect(entry).toHaveAttribute('aria-haspopup', 'dialog');
    expect(entry).toHaveAttribute('aria-expanded', 'false');
    expect(entry.textContent).toBe('');
    expect(entry.querySelector('svg')).not.toBeNull();
    expect(within(screen.getByTestId('app-titlebar-actions')).getAllByRole('button')).toEqual([entry]);
    expect(screen.queryByRole('button', { name: '工作空间' })).toBeNull();
    expect(screen.queryByRole('button', { name: '图片工作台' })).toBeNull();
    act(() => window.dispatchEvent(new CustomEvent('myagent:media-workbench-open', { detail: { path: '/fixture/old-image.png', name: 'old-image.png', type: 'image/png', size: 1 } })));
    expect(screen.queryByRole('dialog', { name: '图片工作台' })).toBeNull();
    fireEvent.click(entry);
    const runtime = screen.getByRole('dialog', { name: '任务中心' });
    await waitFor(() => expect(within(runtime).getByText('任务记录')).toBeInTheDocument());
    expect(entry).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(within(runtime).getByRole('button', { name: '任务与计划' }));
    expect(runtime).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '任务中心' })).toBeNull();
    fireEvent.click(entry);
    fireEvent.click(within(screen.getByRole('dialog', { name: '任务中心' })).getByRole('button', { name: '关闭' }));
    expect(entry).toHaveAttribute('aria-expanded', 'false');
  });

  it('retains document preview through its global entry point', async () => {
    useChatStore.getState().createSession(null);
    render(<App />);
    act(() => openDocumentWorkbench({ path: '/fixture/report.xlsx', name: 'report.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 1 }));
    expect(screen.getByRole('dialog', { name: '文档工作台' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('fixture document unavailable')).toBeInTheDocument());
  });

  it('preserves unsent conversation drafts while starting and switching ordinary chats', () => {
    const original = useChatStore.getState().createSession(null);
    render(<App />);
    fireEvent.change(screen.getByPlaceholderText('请输入…'), { target: { value: '尚未发送的内容' } });
    fireEvent.click(screen.getByRole('button', { name: '新对话' }));
    const selected = useChatStore.getState().sessions.find(s => s.id === useChatStore.getState().currentSessionId)!;
    expect(selected.id).not.toBe(original); expect(selected.projectId).toBeUndefined();
    expect(screen.getByPlaceholderText('请输入…')).toHaveValue('');
    act(() => useChatStore.getState().switchSession(original));
    expect(screen.getByPlaceholderText('请输入…')).toHaveValue('尚未发送的内容');
  });

  it('sends in a new conversation while another turn is still running, without touching the running one', async () => {
    useModelStore.setState({ models: [{ id: 'm', name: 'Mock', provider: 'custom', apiUrl: 'http://127.0.0.1/v1', modelName: 'mock', isLocal: false, maxTokens: 1000 }], activeModelId: 'm' });
    const previous = useChatStore.getState().createSession(null);
    useChatStore.getState().setLoadingSession(previous);
    const selected = useChatStore.getState().createSession(null);
    render(<App />);
    fireEvent.change(screen.getByPlaceholderText('请输入…'), { target: { value: '不能抢走旧对话流的请求' } });
    fireEvent.click(screen.getByTitle('发送 (回车)'));
    await waitFor(() => expect(useChatStore.getState().sessions.find(s => s.id === selected)?.messages[0]).toMatchObject({ role: 'user', content: '不能抢走旧对话流的请求' }));
    expect(screen.queryByText('这个对话还在处理上一条消息，请等待结束，或先停止后再操作。')).toBeNull();
    expect(useChatStore.getState().isLoadingSession(previous)).toBe(true);
    expect(useChatStore.getState().sessions.find(s => s.id === previous)?.messages).toEqual([]);
  });

  it('streams two conversations in parallel; stopping one leaves the other streaming into its own bubble', async () => {
    useSettingStore.setState({ streamResponses: true });
    useModelStore.setState({ models: [{ id: 'm', name: 'Mock', provider: 'custom', apiUrl: 'http://127.0.0.1/v1', modelName: 'mock', isLocal: false, maxTokens: 1000 }], activeModelId: 'm' });
    type Handlers = Parameters<typeof window.electron.subscribeModelStream>[2];
    const streams: { handlers: Handlers; aborted: boolean }[] = [];
    vi.spyOn(window.electron, 'subscribeModelStream').mockImplementation((_messages, _model, handlers) => {
      const entry = { handlers, aborted: false };
      streams.push(entry);
      return () => { entry.aborted = true; };
    });
    const first = useChatStore.getState().createSession(null);
    const second = useChatStore.getState().createSession(null);
    const input = () => screen.getByPlaceholderText('请输入…');
    const assistantOf = (sid: string) => useChatStore.getState().sessions.find(s => s.id === sid)?.messages.find(m => m.role === 'assistant');
    render(<App />);
    act(() => useChatStore.getState().switchSession(first));
    fireEvent.change(input(), { target: { value: '第一个对话的问题' } });
    fireEvent.click(screen.getByTitle('发送 (回车)'));
    await waitFor(() => expect(streams).toHaveLength(1));
    act(() => useChatStore.getState().switchSession(second));
    fireEvent.change(input(), { target: { value: '第二个对话的问题' } });
    fireEvent.click(screen.getByTitle('发送 (回车)'));
    await waitFor(() => expect(streams).toHaveLength(2));
    expect(useChatStore.getState().isLoadingSession(first)).toBe(true);
    expect(useChatStore.getState().isLoadingSession(second)).toBe(true);

    act(() => { streams[0].handlers.onDelta('甲'); streams[1].handlers.onDelta('乙'); });
    await waitFor(() => expect(assistantOf(first)?.content).toBe('甲'));
    await waitFor(() => expect(assistantOf(second)?.content).toBe('乙'));

    act(() => useChatStore.getState().switchSession(first));
    fireEvent.click(await screen.findByTitle('停止生成'));
    expect(streams[0].aborted).toBe(true);
    expect(streams[1].aborted).toBe(false);
    expect(useChatStore.getState().isLoadingSession(first)).toBe(false);
    expect(useChatStore.getState().isLoadingSession(second)).toBe(true);
    act(() => streams[0].handlers.onEnd());

    act(() => { streams[1].handlers.onDelta('完成'); streams[1].handlers.onEnd(); });
    await waitFor(() => expect(useChatStore.getState().isLoadingSession(second)).toBe(false));
    expect(assistantOf(second)?.content).toBe('乙完成');
    expect(assistantOf(first)?.content).toContain('甲');
    expect(assistantOf(first)?.content).not.toContain('完成');
  });

  it('keeps the draft when the same conversation is still running', async () => {
    const selected = useChatStore.getState().createSession(null);
    useChatStore.getState().setLoadingSession(selected);
    const callModel = vi.spyOn(window.electron, 'callModel');
    render(<App />);
    fireEvent.change(screen.getByPlaceholderText('请输入…'), { target: { value: '同一对话里的第二条' } });
    fireEvent.keyDown(screen.getByPlaceholderText('请输入…'), { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('这个对话还在处理上一条消息，请等待结束，或先停止后再操作。')).toBeInTheDocument());
    expect(screen.getByPlaceholderText('请输入…')).toHaveValue('同一对话里的第二条');
    expect(useChatStore.getState().sessions.find(s => s.id === selected)?.messages).toEqual([]);
    expect(callModel).not.toHaveBeenCalled();
  });

  it('keeps flat history and archived data without showing retired workspace actions', () => {
    const project = 'legacy-project';
    const legacy = useChatStore.getState().createSession(null);
    useChatStore.getState().addMessage(legacy, { id: 'old-answer', role: 'assistant', content: '旧回答保留', model: 'fixture', timestamp: 1 });
    useChatStore.setState(state => ({ sessions: state.sessions.map(session => session.id === legacy ? { ...session, projectId: project, title: '保留的历史对话', bookmarkedMessageIds: ['old-answer'] } : session) }));
    render(<App />);
    expect(screen.getByText('保留的历史对话')).toBeInTheDocument();
    expect(screen.getByText('旧回答保留')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: '对话浏览范围' })).toBeNull();
    expect(screen.queryByRole('button', { name: /收藏|工作空间|图片工作台|管理项目/ })).toBeNull();
    const newChat = screen.getByRole('button', { name: '新对话' });
    expect(newChat).toHaveAttribute('title', '新对话'); expect(newChat).toHaveTextContent(/^新对话$/);
    fireEvent.click(newChat);
    expect(useChatStore.getState().sessions.find(s => s.id === useChatStore.getState().currentSessionId)?.projectId).toBeUndefined();
    expect(useChatStore.getState().sessions.find(s => s.id === legacy)).toMatchObject({ projectId: project, bookmarkedMessageIds: ['old-answer'] });
  });

  it('retains image preview and local download without image-editing controls', async () => {
    const save = vi.spyOn(window.electron, 'saveLocalFileCopy').mockResolvedValue({ ok: true });
    render(<ImagePreviewModal src="data:image/png;base64,fixture" localPath="/fixture/image.png" defaultFileName="image.png" alt="已有图片" onClose={() => {}} />);
    expect(screen.getByAltText('已有图片')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '编辑 / 版本' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '下载' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ sourcePath: '/fixture/image.png', defaultFileName: 'image.png' }));
  });

  it('gives the icon an English accessible name and tooltip', () => {
    useSettingStore.setState({ locale: 'en' });
    render(<App />);
    const entry = screen.getByRole('button', { name: 'Task center' });
    expect(entry).toHaveAttribute('title', 'Task center'); expect(entry.textContent).toBe('');
    expect(screen.queryByRole('button', { name: 'Workspace' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Image workbench' })).toBeNull();
  });
});
