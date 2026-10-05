import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SessionList from './SessionList';
import { useChatStore } from '../store/chatStore';
import { useSettingStore } from '../store/settingStore';
import { ImageLibraryContext } from '../context/ImageLibraryContext';
import { confirmDestructive } from '../store/confirmStore';
import { showWarning } from '../store/errorStore';
import type { ChatSession } from '../types';

vi.mock('../store/confirmStore', () => ({ confirmDestructive: vi.fn(async () => true) }));
vi.mock('../store/errorStore', () => ({ showWarning: vi.fn() }));

const conversation = (id: string, title: string, projectId?: string): ChatSession => ({
  id,
  title,
  projectId,
  messages: [{ id: id + '-user', role: 'user', content: 'Message in ' + title, model: 'fixture', timestamp: 1 }],
  createdAt: 1,
  updatedAt: 2,
});
const history = (): ChatSession[] => [
  conversation('general', '普通聊天'),
  conversation('reports-chat', '金额合计', 'reports'),
  { ...conversation('writing-chat', '小说构思', 'writing'), unreadAssistantReply: true },
  {
    ...conversation('orphan', '被保留的历史', 'removed-project'),
    messages: [{
      id: 'orphan-user',
      role: 'user',
      content: 'Message in 被保留的历史',
      model: 'fixture',
      timestamp: 1,
      files: [{ name: '历史图片.png', path: '/fixture/history/image.png', type: 'image/png', size: 42, preview: 'data:image/png;base64,fixture' }],
    }],
    bookmarkedMessageIds: ['orphan-user'],
    branchNames: { 'orphan-user': '历史分支' },
    activeLeafId: 'orphan-user',
  },
];
const row = (id: string) => screen.getByTestId('conversation-row-' + id);
const expectAllHistory = () => {
  for (const session of history()) expect(row(session.id)).toBeInTheDocument();
};
const expectNoProjectControls = () => {
  expect(screen.queryByRole('button', { name: /^(全部|普通|项目已移除|管理项目|All|General|Projects|Manage projects)(\s|$)/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  expect(screen.queryByText(/新对话归属|项目 ·|项目已移除|New conversation in|General chat|Project ·|Project removed/)).not.toBeInTheDocument();
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(confirmDestructive).mockReset().mockResolvedValue(true);
  vi.mocked(showWarning).mockClear();
  useChatStore.setState({ sessions: history(), currentSessionId: 'general', activeLeafId: 'general-user', loadingSessionIds: new Set(), compressingSessionIds: new Set() });
  useSettingStore.setState({ locale: 'zh', theme: 'light', particleFieldEnabled: false });
});
afterEach(cleanup);

describe('complete conversation history without project navigation', () => {
  it('shows ordinary, legacy project and removed-project conversations together without ownership or management controls', () => {
    render(<SessionList />);
    expectAllHistory();
    expect(screen.getByRole('heading', { name: '对话' }).parentElement).toHaveTextContent('4');
    expect(screen.getAllByRole('searchbox')).toHaveLength(1);
    expect(screen.getByRole('searchbox', { name: '搜索对话' })).toBeInTheDocument();
    expectNoProjectControls();
    expect(document.querySelector('#sidebar-project-scopes')).not.toBeInTheDocument();
    for (const session of history()) {
      expect(within(row(session.id)).getByRole('heading', { name: session.title })).toBeInTheDocument();
      expect(row(session.id)).not.toHaveTextContent(/普通对话|项目|归属/);
    }
    expect(useChatStore.getState().sessions).toEqual(history());
  });

  it('searches titles and message contents across every legacy ownership and keeps the total history count', () => {
    render(<SessionList />);
    const search = screen.getByRole('searchbox', { name: '搜索对话' });
    fireEvent.change(search, { target: { value: '  mEsSaGe In  ' } });
    expectAllHistory();
    for (const session of history()) {
      fireEvent.change(search, { target: { value: session.title } });
      expect(screen.getAllByTestId(/^conversation-row-/)).toHaveLength(1);
      expect(row(session.id)).toBeInTheDocument();
    }
    fireEvent.change(search, { target: { value: 'Message in 普通聊天' } });
    expect(row('general')).toBeInTheDocument();
    expect(screen.queryByTestId('conversation-row-orphan')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '对话' }).parentElement).toHaveTextContent('4');
    expect(useChatStore.getState().currentSessionId).toBe('general');
    fireEvent.change(search, { target: { value: '  ' } });
    expectAllHistory();
  });

  it('switches conversations and clears unread replies while preserving legacy project ids and message history', () => {
    render(<SessionList />);
    expect(within(row('writing-chat')).getByTitle('该对话有新回复，点击查看')).toBeInTheDocument();
    for (const session of history()) {
      fireEvent.click(row(session.id));
      const state = useChatStore.getState();
      expect(state.currentSessionId).toBe(session.id);
      expect(state.activeLeafId).toBe(session.activeLeafId ?? session.messages.at(-1)?.id);
      expect(state.sessions.map(({ id, projectId, messages }) => ({ id, projectId, messages })))
        .toEqual(history().map(({ id, projectId, messages }) => ({ id, projectId, messages })));
      expectAllHistory();
    }
    expect(useChatStore.getState().sessions.find(session => session.id === 'writing-chat')?.unreadAssistantReply).toBe(false);
    expect(within(row('writing-chat')).queryByTitle('该对话有新回复，点击查看')).not.toBeInTheDocument();
  });

  it('exports the complete unfiltered history with attachments, branches and legacy metadata', async () => {
    const save = vi.spyOn(window.electron, 'saveTextFile').mockResolvedValue({ ok: true });
    render(<SessionList />);
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索对话' }), { target: { value: '普通聊天' } });
    expect(screen.getAllByTestId(/^conversation-row-/)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '导出全部' }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    const output = save.mock.calls[0][0];
    const backup = JSON.parse(output.content);
    expect(output.defaultName).toMatch(/^myagent-sessions-\d+\.json$/);
    expect(output.filters).toEqual([{ name: 'JSON', extensions: ['json'] }]);
    expect(backup.exportedAt).toEqual(expect.any(String));
    expect(backup.sessions).toEqual(JSON.parse(JSON.stringify(history())));
    expect(backup.sessions.find((session: ChatSession) => session.id === 'orphan').messages[0].files[0]).toEqual(history()[3].messages[0].files?.[0]);
  });

  it('keeps the image library available when a search has no matches', () => {
    const imageLibrary = vi.fn();
    render(<ImageLibraryContext.Provider value={{ openImageLibrary: imageLibrary }}><SessionList /></ImageLibraryContext.Provider>);
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索对话' }), { target: { value: 'missing phrase' } });
    expect(screen.getByText('无匹配对话')).toBeInTheDocument();
    expect(screen.getByText('试试其他关键词。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '图片' }));
    expect(imageLibrary).toHaveBeenCalledOnce();
    expect(useChatStore.getState().sessions).toEqual(history());
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索对话' }), { target: { value: '' } });
    expectAllHistory();
  });

  it('renames with Enter or blur, cancels with Escape and does not switch when editing', () => {
    render(<SessionList />);
    fireEvent.click(within(row('reports-chat')).getByTitle('重命名 (也可双击标题)'));
    fireEvent.change(within(row('reports-chat')).getByRole('textbox'), { target: { value: '  本月统计  ' } });
    fireEvent.keyDown(within(row('reports-chat')).getByRole('textbox'), { key: 'Enter' });
    expect(useChatStore.getState().sessions.find(session => session.id === 'reports-chat')?.title).toBe('本月统计');
    fireEvent.doubleClick(within(row('reports-chat')).getByRole('heading', { name: '本月统计' }));
    fireEvent.change(within(row('reports-chat')).getByRole('textbox'), { target: { value: '取消的标题' } });
    fireEvent.keyDown(within(row('reports-chat')).getByRole('textbox'), { key: 'Escape' });
    expect(within(row('reports-chat')).getByRole('heading', { name: '本月统计' })).toBeInTheDocument();
    fireEvent.click(within(row('reports-chat')).getByTitle('重命名 (也可双击标题)'));
    fireEvent.change(within(row('reports-chat')).getByRole('textbox'), { target: { value: '最终标题' } });
    fireEvent.blur(within(row('reports-chat')).getByRole('textbox'));
    expect(within(row('reports-chat')).getByRole('heading', { name: '最终标题' })).toBeInTheDocument();
    expect(useChatStore.getState().currentSessionId).toBe('general');
    expect(useChatStore.getState().sessions.find(session => session.id === 'reports-chat')?.projectId).toBe('reports');
  });

  it('shows loading state in place of unread badges and restores unread state when generation finishes', () => {
    useChatStore.setState({ loadingSessionIds: new Set(['writing-chat']) });
    render(<SessionList />);
    expect(within(row('writing-chat')).getByLabelText('正在生成回复…')).toBeInTheDocument();
    expect(within(row('writing-chat')).queryByTitle('该对话有新回复，点击查看')).not.toBeInTheDocument();
    act(() => useChatStore.getState().clearLoadingForSession('writing-chat'));
    expect(within(row('writing-chat')).queryByLabelText('正在生成回复…')).not.toBeInTheDocument();
    expect(within(row('writing-chat')).getByTitle('该对话有新回复，点击查看')).toBeInTheDocument();
  });

  it.each(['loading', 'compressing'] as const)('protects a %s conversation from deletion before opening confirmation', (busy) => {
    useChatStore.setState(busy === 'loading' ? { loadingSessionIds: new Set(['reports-chat']) } : { compressingSessionIds: new Set(['reports-chat']) });
    render(<SessionList />);
    fireEvent.click(within(row('reports-chat')).getByTitle('删除对话'));
    expect(showWarning).toHaveBeenCalledWith('chat.anotherConversationBusy');
    expect(confirmDestructive).not.toHaveBeenCalled();
    expect(useChatStore.getState().sessions).toEqual(history());
    expect(useChatStore.getState().currentSessionId).toBe('general');
  });

  it.each(['loading', 'compressing'] as const)('rechecks %s state after delete confirmation resolves', async (busy) => {
    let resolveConfirmation!: (ok: boolean) => void;
    vi.mocked(confirmDestructive).mockImplementationOnce(() => new Promise<boolean>(resolve => { resolveConfirmation = resolve; }));
    render(<SessionList />);
    fireEvent.click(within(row('orphan')).getByTitle('删除对话'));
    expect(confirmDestructive).toHaveBeenCalledWith('确定要删除这个对话吗？');
    act(() => useChatStore.setState(busy === 'loading' ? { loadingSessionIds: new Set(['orphan']) } : { compressingSessionIds: new Set(['orphan']) }));
    await act(async () => { resolveConfirmation(true); });
    expect(showWarning).toHaveBeenCalledWith('chat.anotherConversationBusy');
    expect(row('orphan')).toBeInTheDocument();
    expect(useChatStore.getState().sessions).toEqual(history());
  });

  it('honors canceled deletion and deletes only the confirmed idle conversation', async () => {
    vi.mocked(confirmDestructive).mockResolvedValueOnce(false);
    render(<SessionList />);
    fireEvent.click(within(row('orphan')).getByTitle('删除对话'));
    await waitFor(() => expect(confirmDestructive).toHaveBeenCalledOnce());
    expectAllHistory();
    fireEvent.click(within(row('orphan')).getByTitle('删除对话'));
    await waitFor(() => expect(screen.queryByTestId('conversation-row-orphan')).not.toBeInTheDocument());
    expect(useChatStore.getState().sessions).toEqual(history().slice(0, 3));
    expect(useChatStore.getState().currentSessionId).toBe('general');
    expect(screen.getByRole('heading', { name: '对话' }).parentElement).toHaveTextContent('3');
    expect(showWarning).not.toHaveBeenCalled();
  });

  it('offers the ordinary empty-history state and image library without project navigation or creating a session', () => {
    useChatStore.setState({ sessions: [], currentSessionId: null, activeLeafId: null });
    const imageLibrary = vi.fn();
    render(<ImageLibraryContext.Provider value={{ openImageLibrary: imageLibrary }}><SessionList /></ImageLibraryContext.Provider>);
    expect(screen.getByRole('heading', { name: '对话' }).parentElement).toHaveTextContent('0');
    expect(screen.getByText('暂无对话记录')).toBeInTheDocument();
    expect(screen.getByText('点击下方「新对话」即可开始。')).toBeInTheDocument();
    expectNoProjectControls();
    expect(screen.queryByRole('button', { name: '导出全部' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '图片' }));
    expect(imageLibrary).toHaveBeenCalledOnce();
    expect(useChatStore.getState().sessions).toEqual([]);
    expect(useChatStore.getState().currentSessionId).toBeNull();
  });

  it.each(['light', 'dark'] as const)('renders English conversation controls and states with the %s theme', (theme) => {
    useSettingStore.setState({ locale: 'en', theme });
    render(<SessionList />);
    expectAllHistory();
    expect(screen.getByRole('heading', { name: 'Conversations' }).parentElement).toHaveTextContent('4');
    const search = screen.getByRole('searchbox', { name: 'Search conversations' });
    expect(search).toHaveAttribute('placeholder', 'Search chats…');
    expect(screen.getByRole('button', { name: 'Export all' })).toHaveAttribute('title', 'Export all sessions as a backup file');
    expect(screen.getByRole('button', { name: 'Images' })).toBeInTheDocument();
    expect(within(row('writing-chat')).getByTitle('New reply in this chat')).toBeInTheDocument();
    expect(within(row('reports-chat')).getByTitle('Rename (or double-click title)')).toBeInTheDocument();
    expect(within(row('reports-chat')).getByTitle('Delete chat')).toBeInTheDocument();
    expectNoProjectControls();
    act(() => useChatStore.getState().setLoadingSession('reports-chat'));
    expect(within(row('reports-chat')).getByLabelText('Generating reply…')).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'unmatched' } });
    expect(screen.getByText('No matches')).toBeInTheDocument();
    expect(screen.getByText('Try another keyword.')).toBeInTheDocument();
    fireEvent.change(search, { target: { value: '' } });
    fireEvent.click(row('orphan'));
    expect(useSettingStore.getState().theme).toBe(theme);
    expect(useChatStore.getState().sessions.find(session => session.id === 'orphan')?.projectId).toBe('removed-project');
  });
});
