import React from 'react';
import { FiCheckSquare, FiDownload, FiGlobe, FiTrash2, FiX } from 'react-icons/fi';
import { IosSwitch } from '../IosSwitch';

export interface ChatToolbarProps {
  /** 当前会话是否存在（用于决定是否显示整个工具条） */
  visible: boolean;
  webEffective: boolean;
  onWebChange: (v: boolean) => void;
  webSwitchLabel: string;
  webLabel: string;
  selectionMode: boolean;
  selectedCount: number;
  isCurrentSessionLoading: boolean;
  messagesEmpty: boolean;
  onDeleteSelected: () => void;
  onCancelSelection: () => void;
  onStartSelection: () => void;
  onExport: (kind: 'md' | 'html') => void;
  selectedCountLabel: string;
  deleteSelectedLabel: string;
  cancelSelectLabel: string;
  selectMessagesLabel: string;
  exportMdTitle: string;
  exportHtmlTitle: string;
}

/**
 * 顶部工具条：联网切换、多选、导出。
 * 该组件只做渲染 + 回调暴露，不调 store / 不调 i18n（除 props 传入的 label 外）。
 */
export const ChatToolbar: React.FC<ChatToolbarProps> = (p) => {
  if (!p.visible) return null;

  return (
    <div className="shrink-0 flex flex-wrap items-center gap-2 border-b border-stone-600/20 px-6 py-2 dark:border-white/10 bg-stone-100/50 dark:bg-slate-900/40">
      <div className="flex items-center gap-2.5 text-xs text-stone-600 dark:text-slate-400">
        <div className="flex items-center gap-1.5">
          <FiGlobe size={14} className="shrink-0" aria-hidden />
          <span>{p.webLabel}</span>
        </div>
        <IosSwitch
          checked={p.webEffective}
          aria-label={p.webSwitchLabel}
          onChange={(v) => p.onWebChange(v)}
        />
      </div>
      <div className="ml-auto flex items-center gap-1">
        {p.selectionMode ? (
          <>
            <span className="mr-1 text-xs text-stone-500 dark:text-slate-400">
              {p.selectedCountLabel}
            </span>
            <button
              type="button"
              onClick={p.onDeleteSelected}
              disabled={p.selectedCount === 0 || p.isCurrentSessionLoading}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-red-600 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-45 dark:text-red-300 dark:hover:bg-red-950/45"
              title={p.deleteSelectedLabel}
            >
              <FiTrash2 size={14} /> {p.deleteSelectedLabel}
            </button>
            <button
              type="button"
              onClick={p.onCancelSelection}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-stone-600 hover:bg-stone-200/80 dark:text-slate-300 dark:hover:bg-slate-800"
              title={p.cancelSelectLabel}
            >
              <FiX size={14} /> {p.cancelSelectLabel}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={p.onStartSelection}
            disabled={p.messagesEmpty || p.isCurrentSessionLoading}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-stone-600 hover:bg-stone-200/80 disabled:cursor-not-allowed disabled:opacity-45 dark:text-slate-300 dark:hover:bg-slate-800"
            title={p.selectMessagesLabel}
          >
            <FiCheckSquare size={14} /> {p.selectMessagesLabel}
          </button>
        )}
        <button
          type="button"
          onClick={() => p.onExport('md')}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-stone-600 hover:bg-stone-200/80 dark:text-slate-300 dark:hover:bg-slate-800"
          title={p.exportMdTitle}
        >
          <FiDownload size={14} /> MD
        </button>
        <button
          type="button"
          onClick={() => p.onExport('html')}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-stone-600 hover:bg-stone-200/80 dark:text-slate-300 dark:hover:bg-slate-800"
          title={p.exportHtmlTitle}
        >
          <FiDownload size={14} /> HTML
        </button>
      </div>
    </div>
  );
};