import React from 'react';
import { FiFileText } from 'react-icons/fi';

interface DocumentGeneratingPlaceholderProps {
  t: (key: string) => string;
}

/** 文档生成占位（含 shimmer 进度条），与模型 streaming 占位文案配合 */
const DocumentGeneratingPlaceholder: React.FC<DocumentGeneratingPlaceholderProps> = ({ t }) => {
  return (
    <div className="font-mono text-[11px] leading-relaxed text-emerald-100/88" role="status" aria-live="polite">
      <div className="flex items-start gap-2 text-emerald-400/90">
        <span aria-hidden className="select-none shrink-0">
          ▸
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="text-emerald-200/95">{t('chat.documentGenWorking')}</div>
          <div className="text-emerald-600/85 dark:text-emerald-500/80">{t('chat.documentGenWorkingSub')}</div>
          <div className="myagent-image-gen-loading-shimmer relative mt-1 flex h-6 items-center overflow-hidden rounded border border-emerald-800/40 bg-gradient-to-r from-emerald-950/85 via-slate-950/50 to-emerald-900/35 px-2">
            <FiFileText size={13} className="relative z-10 text-emerald-500/88" aria-hidden />
            <div className="relative z-10 ml-2 h-1 flex-1 overflow-hidden rounded-full bg-black/45">
              <div className="h-full w-2/5 animate-pulse rounded-full bg-emerald-400/42" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DocumentGeneratingPlaceholder;
