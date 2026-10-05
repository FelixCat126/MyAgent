import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import { useChatStore } from '../../store/chatStore';
import { useProjectStore } from '../../store/projectStore';
import { useWorkflowStore } from '../../store/workflowStore';
import { useMemoryStore } from '../../store/memoryStore';
import { useSettingStore } from '../../store/settingStore';
import { openDocumentWorkbench } from '../documents/events';
import { ImagePreviewModal } from '../../components/MessageItem/ImagePreviewModal';
import { PERSIST_KEYS } from '../../utils/persistKeys';

beforeEach(() => {
  localStorage.setItem(PERSIST_KEYS.onboarding, '1');
  useChatStore.setState({ sessions: [], currentSessionId: null, activeLeafId: null, loadingSessionIds: new Set(), compressingSessionIds: new Set() });
  useProjectStore.setState({ projects: [], activeProjectId: null });
  useWorkflowStore.setState({ workflows: [] });
  useMemoryStore.setState({ memories: [] });
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

  it('keeps a new conversation draft when another turn is still running', async () => {
    const previous = useChatStore.getState().createSession(null);
    useChatStore.getState().setLoadingSession(previous);
    const selected = useChatStore.getState().createSession(null);
    const callModel = vi.spyOn(window.electron, 'callModel');
    render(<App />);
    fireEvent.change(screen.getByPlaceholderText('请输入…'), { target: { value: '不能抢走旧对话流的请求' } });
    fireEvent.click(screen.getByTitle('发送 (回车)'));
    await waitFor(() => expect(screen.getByText('还有一个对话或任务正在运行，请等待结束，或先停止它后再发送。')).toBeInTheDocument());
    expect(screen.getByPlaceholderText('请输入…')).toHaveValue('不能抢走旧对话流的请求');
    expect(useChatStore.getState().sessions.find(s => s.id === selected)?.messages).toEqual([]);
    expect(callModel).not.toHaveBeenCalled();
  });

  it('keeps flat history and archived data without showing retired workspace actions', () => {
    const project = useProjectStore.getState().createProject({ name: '旧资料', rules: '旧规则' });
    useWorkflowStore.getState().createWorkflow({ name: '旧配方', template: '旧内容', projectId: null, outputFormat: 'auto', variables: [] });
    useMemoryStore.getState().addMemory({ content: '旧偏好', scope: 'personal', status: 'confirmed', kind: 'preference', source: { kind: 'manual' } });
    const legacy = useChatStore.getState().createSession(null);
    useChatStore.getState().addMessage(legacy, { id: 'old-answer', role: 'assistant', content: '旧回答保留', model: 'fixture', timestamp: 1 });
    useChatStore.setState(state => ({ sessions: state.sessions.map(session => session.id === legacy ? { ...session, projectId: project, title: '保留的历史对话', bookmarkedMessageIds: ['old-answer'] } : session) }));
    const memories = structuredClone(useMemoryStore.getState().memories);
    const workflows = structuredClone(useWorkflowStore.getState().workflows);
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
    expect(useMemoryStore.getState().memories).toEqual(memories); expect(useWorkflowStore.getState().workflows).toEqual(workflows);
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
