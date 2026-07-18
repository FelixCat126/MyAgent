import React from 'react';
import { FiFile, FiImage } from 'react-icons/fi';

export interface AttachmentStripProps {
  attachments: File[];
  attachmentPreviews: Record<string, string>;
  onRemoveAttachment: (index: number) => void;
  removeFileLabel: string;
  attachmentsAriaLabel: string;
}

/**
 * 附件渲染条：当存在附件时展示缩略图/文件图标，可逐个移除。
 * 无附件时返回 null。
 */
export const AttachmentStrip: React.FC<AttachmentStripProps> = ({
  attachments,
  attachmentPreviews,
  onRemoveAttachment,
  removeFileLabel,
  attachmentsAriaLabel,
}) => {
  if (attachments.length === 0) return null;

  return (
    <div
      className="flex shrink-0 flex-wrap justify-start gap-2 border-b border-stone-600/25 bg-transparent px-6 py-1.5 dark:border-white/10"
      aria-label={attachmentsAriaLabel}
    >
      {attachments.map((file, index) => {
        const preview = attachmentPreviews[file.name];
        const isImage = file.type.startsWith('image/');
        const showThumb = isImage && !!preview;
        return (
          <div
            key={`${file.name}-${index}`}
            className="relative flex w-[92px] shrink-0 flex-col items-center gap-1 rounded-lg border border-primary-400/55 bg-transparent px-1 pb-1.5 pt-1 dark:border-primary-500/45"
          >
            <button
              type="button"
              onClick={() => onRemoveAttachment(index)}
              className="absolute -right-1 -top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-stone-400/50 bg-stone-100 text-[11px] leading-none text-stone-600 shadow-sm hover:bg-stone-200 dark:border-white/20 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
              title={removeFileLabel}
            >
              ×
            </button>
            <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-md border-2 border-primary-500/70 bg-stone-100/80 shadow-sm dark:border-primary-400/60 dark:bg-slate-900/40">
              {showThumb ? (
                <img src={preview} alt="" className="h-full w-full object-cover" />
              ) : isImage ? (
                <FiImage className="text-stone-400 dark:text-slate-500" size={22} aria-hidden />
              ) : (
                <FiFile className="text-stone-600 dark:text-slate-300" size={22} aria-hidden />
              )}
            </div>
            <span className="w-full truncate px-0.5 text-center text-[10px] font-medium leading-tight text-stone-800 dark:text-slate-100">
              {file.name}
            </span>
          </div>
        );
      })}
    </div>
  );
};
