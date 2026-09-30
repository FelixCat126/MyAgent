import React from 'react';
import { FiDownload, FiImage, FiLoader, FiMaximize2 } from 'react-icons/fi';
import type { FileInfo } from '../../types';
import { attachmentImageDisplaySrc } from '@/utils/attachmentDisplaySrc';
import { artifactDisplayName } from './DocumentAttachmentCard';

interface ImageGeneratingPlaceholderProps {
  progress: { current: number; total: number };
  files?: FileInfo[];
  openAttachmentPreview?: (name: string, src: string, path: string, index: number) => void;
  downloadAttachmentCopy?: (
    e: React.MouseEvent,
    path: string,
    name: string,
    displaySrc?: string
  ) => void | Promise<void>;
  t: (key: string, params?: Record<string, string | number>) => string;
}

/** 只展示已完成图片与当前生成位，避免未来空槽抢占视觉层级。 */
const ImageGeneratingPlaceholder: React.FC<ImageGeneratingPlaceholderProps> = ({
  progress,
  files,
  openAttachmentPreview,
  downloadAttachmentCopy,
  t,
}) => {
  const imageFiles = (files ?? []).filter((f) => f.type.startsWith('image/'));
  const total = Math.min(Math.max(progress.total, 1), 24);
  const completed = Math.min(imageFiles.length, total);
  const showActiveSlot = completed < total;
  const percentage = Math.max(4, Math.min(100, Math.round((completed / total) * 100)));
  const oneImage = total === 1;

  return (
    <div
      className="rounded-xl border border-stone-300/65 bg-white/85 p-3 text-stone-800 shadow-sm dark:border-white/10 dark:bg-slate-900/45 dark:text-slate-100"
      role="status"
      aria-live="polite"
    >
      <div className="mb-3 flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-500/10 text-primary-700 dark:bg-primary-400/12 dark:text-primary-200">
          <FiLoader size={15} className="animate-spin" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3 text-[12px]">
            <span className="font-semibold">{t('chat.imageGenWorking')}</span>
            <span className="shrink-0 tabular-nums text-stone-500 dark:text-slate-400">
              {t('chat.imageGenProgress', { current: completed, total })}
            </span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-stone-200 dark:bg-slate-700">
            <div
              className="h-full rounded-full bg-gradient-to-r from-primary-500 to-teal-400 transition-[width] duration-500"
              style={{ width: `${percentage}%` }}
            />
          </div>
        </div>
      </div>

      <div
        className={
          oneImage
            ? 'grid w-[min(520px,66vw)] max-w-full grid-cols-1 gap-2'
            : 'grid w-[min(660px,68vw)] max-w-full grid-cols-1 gap-2 sm:grid-cols-2'
        }
      >
        {imageFiles.slice(0, total).map((file, idx) => {
          const displaySrc = attachmentImageDisplaySrc(file);
          const displayName = artifactDisplayName(file.name, t('message.imageAlt'));
          return (
            <div
              key={file.path || `img-${idx}`}
              className="group/generated relative aspect-[4/3] min-w-0 overflow-hidden rounded-xl border border-stone-300/65 bg-stone-100 dark:border-white/10 dark:bg-slate-950/45"
              title={file.name}
            >
              <button
                type="button"
                className="flex h-full w-full items-center justify-center"
                onClick={() => displaySrc && openAttachmentPreview?.(file.name, displaySrc, file.path, idx)}
                aria-label={`${t('message.imageOpenPreview')} ${displayName}`}
              >
                <img src={displaySrc} alt={displayName} className="h-full w-full object-contain" />
              </button>
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/65 to-transparent px-3 pb-2 pt-8 text-white opacity-100 transition sm:opacity-0 sm:group-hover/generated:opacity-100">
                <span className="min-w-0 truncate text-[10px] font-medium text-white/90">{displayName}</span>
                <FiMaximize2 size={12} className="shrink-0 opacity-80" aria-hidden />
              </div>
              {downloadAttachmentCopy ? (
                <button
                  type="button"
                  className="absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/20 bg-black/45 text-white opacity-100 backdrop-blur-sm transition hover:bg-black/65 sm:opacity-0 sm:group-hover/generated:opacity-100"
                  title={t('message.imagePreviewDownload')}
                  aria-label={`${t('message.imagePreviewDownload')} ${displayName}`}
                  onClick={(e) => void downloadAttachmentCopy(e, file.path, file.name, displaySrc)}
                >
                  <FiDownload size={14} aria-hidden />
                </button>
              ) : null}
            </div>
          );
        })}

        {showActiveSlot ? (
          <div className="myagent-image-gen-loading-shimmer relative aspect-[4/3] overflow-hidden rounded-xl border border-primary-400/50 bg-stone-100/90 ring-2 ring-primary-400/20 dark:border-primary-500/40 dark:bg-slate-800/55 dark:ring-primary-500/18">
            <div className="relative z-10 flex h-full flex-col items-center justify-center gap-2 text-primary-700 dark:text-primary-200">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white/65 shadow-sm backdrop-blur-sm dark:bg-slate-900/60">
                {completed === 0 ? <FiImage size={20} aria-hidden /> : <FiLoader size={19} className="animate-spin" aria-hidden />}
              </span>
              <span className="rounded-full bg-white/65 px-2.5 py-1 text-[10px] font-medium tabular-nums backdrop-blur-sm dark:bg-slate-900/60">
                {completed + 1} / {total}
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default ImageGeneratingPlaceholder;
