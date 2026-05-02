import React, { useMemo, useState } from 'react';
import { useChatStore } from '../store/chatStore';
import { ChatSession } from '../types';
import { filterSessionsByQuery } from '../utils/sessionFilter';
import { FiTrash2, FiEdit2, FiSearch, FiDownload, FiImage } from 'react-icons/fi';
import { useI18n } from '../hooks/useI18n';
import { useImageLibraryOpener } from '../context/ImageLibraryContext';

const SessionList: React.FC = () => {
  const { t, locale } = useI18n();
  const openImageLibrary = useImageLibraryOpener();
  const { sessions, currentSessionId, switchSession, deleteSession, updateSessionTitle } = useChatStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [search, setSearch] = useState('');

  const filtered = useMemo(
    () => filterSessionsByQuery(sessions, search),
    [sessions, search]
  );

  const exportAllJson = async () => {
    const raw = JSON.stringify(
      { exportedAt: new Date().toISOString(), sessions },
      null,
      2
    );
    await window.electron.saveTextFile({
      defaultName: `myagent-sessions-${Date.now()}.json`,
      content: raw,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
  };

  const handleDelete = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    if (confirm(t('sessionList.confirmDelete'))) {
      deleteSession(sessionId);
    }
  };

  const startEdit = (e: React.MouseEvent, session: ChatSession) => {
    e.stopPropagation();
    setEditingId(session.id);
    setEditTitle(session.title);
  };

  const saveEdit = (sessionId: string) => {
    if (editTitle.trim()) {
      updateSessionTitle(sessionId, editTitle.trim());
    }
    setEditingId(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent, sessionId: string) => {
    if (e.key === 'Enter') {
      saveEdit(sessionId);
    } else if (e.key === 'Escape') {
      setEditingId(null);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="shrink-0 px-2 pt-2 pb-1 space-y-1.5">
        <div className="relative">
          <FiSearch
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400 dark:text-slate-500"
            size={14}
            aria-hidden
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('sessionList.search')}
            className="w-full rounded-lg border border-stone-400/30 bg-stone-100/80 py-1.5 pl-8 pr-2 text-xs text-stone-800 placeholder-stone-400 focus:border-primary-500/60 focus:outline-none focus:ring-1 focus:ring-primary-500/50 dark:border-slate-600 dark:bg-slate-800/80 dark:text-slate-100"
          />
        </div>
        <div className="flex w-full gap-1.5">
          {sessions.length > 0 ? (
            <button
              type="button"
              onClick={() => void exportAllJson()}
              className="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg border border-stone-400/25 bg-stone-100/60 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-200/80 dark:border-slate-600 dark:bg-slate-800/50 dark:text-slate-300 dark:hover:bg-slate-800"
              title={t('sessionList.exportAllTitle')}
            >
              <FiDownload size={14} />
              {t('sessionList.exportAll')}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => openImageLibrary()}
            className={`flex min-w-0 items-center justify-center gap-1.5 rounded-lg border border-stone-400/25 bg-stone-100/60 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-200/80 dark:border-slate-600 dark:bg-slate-800/50 dark:text-slate-300 dark:hover:bg-slate-800 ${
              sessions.length > 0 ? 'flex-1' : 'w-full'
            }`}
            title={t('sessionList.imageLibraryTitle')}
          >
            <FiImage size={14} />
            {t('sessionList.imageLibrary')}
          </button>
        </div>
      </div>
      {sessions.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-stone-500 dark:text-slate-500 p-4">
          <p className="text-sm font-medium">{t('sessionList.empty')}</p>
        </div>
      ) : (
    <div className="flex-1 min-h-0 overflow-y-auto px-2 py-1 space-y-1">
      {filtered.map((session: ChatSession) => (
        <div
          key={session.id}
          onClick={() => {
            if (editingId !== session.id) switchSession(session.id);
          }}
          className={`px-4 py-3 rounded-xl cursor-pointer transition-all ${
            currentSessionId === session.id
              ? 'bg-stone-100/90 dark:bg-slate-800 shadow-sm border border-stone-600/38 dark:border-white/10 relative overflow-hidden'
              : 'hover:bg-stone-400/15 dark:hover:bg-slate-800/50 border border-transparent'
          } group`}
        >
          {currentSessionId === session.id && (
            <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-primary-400 to-primary-600"></div>
          )}
          <div className="flex justify-between items-start gap-2">
            <div className="flex-1 min-w-0 pr-0">
              {editingId === session.id ? (
                <input
                  autoFocus
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onKeyDown={(e) => handleKeyDown(e, session.id)}
                  onBlur={() => saveEdit(session.id)}
                  onClick={(e) => e.stopPropagation()}
                  className="w-full bg-stone-200/90 dark:bg-slate-700 text-sm px-2 py-0.5 rounded outline-none border border-primary-500/50 text-stone-900 dark:text-white"
                />
              ) : (
                <div className="flex items-center gap-2 min-w-0">
                  <h3
                    className={`font-medium text-sm truncate min-w-0 flex-1 block ${currentSessionId === session.id ? 'text-stone-900 dark:text-white' : 'text-stone-700 dark:text-slate-300'}`}
                    onDoubleClick={(e) => startEdit(e, session)}
                    title={session.title}
                  >
                    {session.title}
                  </h3>
                  {session.unreadAssistantReply && currentSessionId !== session.id ? (
                    <span
                      className="flex-shrink-0 inline-flex h-5 min-w-[1.25rem] px-1 items-center justify-center rounded-md bg-primary-500 text-[10px] font-bold text-white shadow-md shadow-primary-500/30"
                      title={t('sessionList.badgeTitle')}
                    >
                      {t('sessionList.badge')}
                    </span>
                  ) : null}
                </div>
              )}
              <p className="text-xs text-stone-500 dark:text-slate-500 mt-1.5 font-medium">
                {new Date(session.updatedAt).toLocaleDateString(locale === 'en' ? 'en-US' : 'zh-CN')}{' '}
                {new Date(session.updatedAt).toLocaleTimeString(locale === 'en' ? 'en-US' : 'zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </p>
            </div>
            
            {/* 隐藏按钮组 */}
            <div
              className={`flex flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity ${editingId === session.id ? 'hidden' : ''}`}
            >
              <button
                onClick={(e) => startEdit(e, session)}
                className="p-1.5 hover:bg-stone-400/20 dark:hover:bg-slate-700 rounded-lg transition-colors text-stone-500 hover:text-primary-500 mr-1"
                title={t('sessionList.rename')}
              >
                <FiEdit2 size={13} />
              </button>
              <button
                onClick={(e) => handleDelete(e, session.id)}
                className="p-1.5 hover:bg-red-50/80 dark:hover:bg-red-500/10 rounded-lg transition-colors text-stone-500 hover:text-red-500"
                title={t('sessionList.delete')}
              >
                <FiTrash2 size={13} />
              </button>
            </div>
          </div>
        </div>
      ))}
      {filtered.length === 0 && search.trim() && (
        <p className="px-2 py-4 text-center text-xs text-stone-500 dark:text-slate-500">{t('sessionList.noMatch')}</p>
      )}
    </div>
      )}
    </div>
  );
};

export default SessionList;
