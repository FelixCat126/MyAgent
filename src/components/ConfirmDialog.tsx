import React, { useEffect } from 'react';
import { useConfirmStore } from '../store/confirmStore';
import { useI18n } from '../hooks/useI18n';

/** 挂在 App 根部；由 confirmDestructive() 驱动 */
const ConfirmDialog: React.FC = () => {
  const pending = useConfirmStore((s) => s.pending);
  const settle = useConfirmStore((s) => s.settle);
  const { t } = useI18n();

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') settle(false);
      if (e.key === 'Enter') settle(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, settle]);

  if (!pending) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4"
      role="presentation"
      onClick={() => settle(false)}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="w-full max-w-sm rounded-xl border border-stone-300/60 bg-stone-50 p-4 shadow-lg dark:border-slate-600 dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <p id="confirm-dialog-title" className="text-sm leading-relaxed text-stone-800 dark:text-slate-100">
          {pending.message}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-stone-400/35 bg-stone-100/95 px-3 py-1.5 text-xs font-medium text-stone-800 hover:bg-stone-200/90 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
            onClick={() => settle(false)}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
            onClick={() => settle(true)}
            autoFocus
          >
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmDialog;
