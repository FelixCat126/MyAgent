import React, { useMemo, useState } from 'react';
import { useChatStore } from '../store/chatStore';
import { ChatSession } from '../types';
import { filterSessionsByQuery } from '../utils/sessionFilter';
import { FiTrash2, FiEdit2, FiSearch, FiDownload, FiImage, FiLoader } from 'react-icons/fi';
import { useI18n } from '../hooks/useI18n';
import { useResolvedTheme } from '../hooks/useResolvedTheme';
import { useSettingStore } from '../store/settingStore';
import { useImageLibraryOpener } from '../context/ImageLibraryContext';
import FloatingParticleWindow from './FloatingParticleWindow';
import { formatDateTime } from '../utils/formatDateTime';
import { confirmDestructive } from '../store/confirmStore';

const SessionList: React.FC = () => {
  const { t, locale } = useI18n();
  const resolvedTheme = useResolvedTheme();
  const particleFieldEnabled = useSettingStore((s) => s.particleFieldEnabled);
  const openImageLibrary = useImageLibraryOpener();
  const sessions = useChatStore((s) => s.sessions);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const switchSession = useChatStore((s) => s.switchSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const updateSessionTitle = useChatStore((s) => s.updateSessionTitle);
  const loadingSessionIds = useChatStore((s) => s.loadingSessionIds);
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
    void confirmDestructive(t('sessionList.confirmDelete')).then((ok) => {
      if (ok) deleteSession(sessionId);
    });
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
        {particleFieldEnabled ? (
          <FloatingParticleWindow visible themeMode={resolvedTheme} />
        ) : null}
        <div className="relative">
          <FiSearch
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-600 dark:text-slate-300"
            size={14}
            aria-hidden
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('sessionList.search')}
            className="w-full rounded-lg border border-stone-400/30 bg-stone-100/80 py-1.5 pl-8 pr-2 text-xs text-stone-800 placeholder-stone-600 dark:placeholder-slate-300 focus:border-primary-500/60 focus:outline-none focus:ring-1 focus:ring-primary-500/50 dark:border-slate-600 dark:bg-slate-800/80 dark:text-slate-100"
          />
        </div>
        <div className="flex w-full gap-1.5">
          {sessions.length > 0 ? (
            <button
              type="button"
              onClick={() => void exportAllJson()}
              className="flex min-w-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-stone-400/25 bg-stone-100/60 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-200/80 dark:border-slate-600 dark:bg-slate-800/50 dark:text-slate-300 dark:hover:bg-slate-800"
              title={t('sessionList.exportAllTitle')}
            >
              <FiDownload size={14} className="shrink-0" />
              <span className="truncate">{t('sessionList.exportAll')}</span>
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => openImageLibrary()}
            className={`flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-stone-400/25 bg-stone-100/60 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-200/80 dark:border-slate-600 dark:bg-slate-800/50 dark:text-slate-300 dark:hover:bg-slate-800 ${
              sessions.length > 0 ? 'flex-1' : 'w-full'
            }`}
            title={t('sessionList.imageLibraryTitle')}
          >
            <FiImage size={14} className="shrink-0" />
            <span className="truncate">{t('sessionList.imageLibrary')}</span>
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
                </div>
              )}
              <p
                className="mt-1.5 truncate whitespace-nowrap text-xs font-medium text-stone-500 dark:text-slate-500"
                title={formatDateTime(session.updatedAt, locale)}
              >
                {formatDateTime(session.updatedAt, locale)}
              </p>
            </div>
            
            {/* 右侧区域：转圈/亮点（槽位1） + 编辑（槽位2） + 删除（槽位3），三槽位等宽等距 */}
            {(() => {
              if (editingId === session.id) {
                return <div className="flex flex-shrink-0" />;
              }
              const isCurrent = currentSessionId === session.id;
              const isLoading = loadingSessionIds.has(session.id);
              /** 完成亮点：非选中 + 未读才显示；选中不显示 */
              const showDot = !isCurrent && !isLoading && session.unreadAssistantReply;
              /** 统一槽位：固定 28px 方块，内含 13px 图标，间距统一 gap-0.5(2px) */
              const slot = 'flex items-center justify-center w-7 h-7 shrink-0';
              return (
                <div className="flex flex-shrink-0 items-start gap-0.5 pt-[1px]">
                  {/* 槽位1：转圈（loading）或亮点（完成未读），始终占位保持布局稳定 */}
                  <span
                    className={`${slot} transition-opacity ${
                      isLoading || showDot ? 'opacity-100' : 'opacity-0'
                    }`}
                    title={isLoading ? t('sessionList.loading') : showDot ? t('sessionList.badgeTitle') : undefined}
                  >
                    {isLoading ? (
                      <FiLoader
                        size={13}
                        className="animate-spin text-primary-500 dark:text-primary-400"
                        aria-label={t('sessionList.loading')}
                      />
                    ) : showDot ? (
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary-500" />
                    ) : null}
                  </span>

                  {/* 槽位2：编辑按钮 */}
                  <div className={`${slot} opacity-0 group-hover:opacity-100 transition-opacity`}>
                    <button
                      onClick={(e) => startEdit(e, session)}
                      className="flex items-center justify-center w-full h-full rounded-lg hover:bg-stone-400/20 dark:hover:bg-slate-700 transition-colors text-stone-600 dark:text-slate-300 hover:text-primary-500"
                      title={t('sessionList.rename')}
                    >
                      <FiEdit2 size={13} />
                    </button>
                  </div>

                  {/* 槽位3：删除按钮 */}
                  <div className={`${slot} opacity-0 group-hover:opacity-100 transition-opacity`}>
                    <button
                      onClick={(e) => handleDelete(e, session.id)}
                      className="flex items-center justify-center w-full h-full rounded-lg hover:bg-red-50/80 dark:hover:bg-red-500/10 transition-colors text-stone-600 dark:text-slate-300 hover:text-red-500"
                      title={t('sessionList.delete')}
                    >
                      <FiTrash2 size={13} />
                    </button>
                  </div>
                </div>
              );
            })()}
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
