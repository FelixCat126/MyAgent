import React from 'react';
import { FiDownload, FiImage, FiLoader } from 'react-icons/fi';
import type { FileInfo } from '../../types';
import { attachmentImageDisplaySrc } from '@/utils/attachmentDisplaySrc';
import {
  MULTI_IMAGE_ATTACHMENT_GRID,
  ASSISTANT_IMAGE_THUMB_FRAME,
  ASSISTANT_IMAGE_THUMB_IMG,
  ASSISTANT_IMAGE_THUMB_META_ROW,
} from './styleConstants';

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

/** 图像生成占位：网格展示已生成图 + 当前生成槽位（旋转 spinner） */
const ImageGeneratingPlaceholder: React.FC<ImageGeneratingPlaceholderProps> = ({
  progress,
  files,
  openAttachmentPreview,
  downloadAttachmentCopy,
  t,
}) => {
  const imageFiles = (files ?? []).filter((f) => f.type.startsWith('image/'));
  const slotCount = Math.min(Math.max(progress.total, 1), 24);

  return (
    <div
      className="rounded-lg border border-stone-300/55 bg-white/85 p-2.5 text-stone-800 shadow-sm dark:border-slate-600/60 dark:bg-slate-800/75 dark:text-slate-100"
      role="status"
      aria-live="polite"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2 border-b border-stone-200/90 pb-2 text-[11px] text-stone-600 dark:border-slate-600/65 dark:text-slate-400">
        <FiLoader size={13} className="shrink-0 animate-spin text-primary-600 dark:text-primary-300" aria-hidden />
        <span>
          {t('chat.imageGenWorking')}
          {progress.total > 1 ? (
            <span className="ml-1.5 tabular-nums text-stone-500 dark:text-slate-500">
              {t('chat.imageGenWorkingTotal', { total: progress.total })}
            </span>
          ) : null}
        </span>
      </div>
      <div className={MULTI_IMAGE_ATTACHMENT_GRID}>
        {Array.from({ length: slotCount }).map((_, idx) => {
          const file = imageFiles[idx];
          if (file) {
            const displaySrc = attachmentImageDisplaySrc(file);
            return (
              <div key={file.path || `img-${idx}`} className="relative min-w-0 transition-all" title={file.name}>
                <div className="flex w-max flex-col gap-1">
                  <img
                    src={displaySrc}
                    alt={file.name}
                    onClick={() => displaySrc && openAttachmentPreview?.(file.name, displaySrc, file.path, idx)}
                    className={`${ASSISTANT_IMAGE_THUMB_IMG} bg-stone-50 dark:bg-slate-900/35`}
                  />
                  <div className={ASSISTANT_IMAGE_THUMB_META_ROW}>
                    <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-stone-700 dark:text-slate-300">
                      {file.name}
                    </span>
                    {downloadAttachmentCopy ? (
                      <button
                        type="button"
                        className="shrink-0 rounded p-0.5 text-stone-500 hover:bg-stone-100 dark:text-slate-400 dark:hover:bg-slate-700/80"
                        title={t('message.imagePreviewDownload')}
                        aria-label={t('message.imagePreviewDownload')}
                        onClick={(e) =>
                          void downloadAttachmentCopy(e, file.path, file.name, displaySrc)
                        }
                      >
                        <FiDownload size={12} aria-hidden />
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          }
          const active = idx === imageFiles.length;
          return (
            <div key={`slot-${idx}`} className="flex w-max flex-col gap-1">
              <div
                className={`relative myagent-image-gen-loading-shimmer flex ${ASSISTANT_IMAGE_THUMB_FRAME} flex-col items-center justify-center overflow-hidden rounded-md border bg-stone-100/95 dark:bg-slate-700/35 ${
                  active
                    ? 'border-primary-400/65 ring-2 ring-primary-400/35 dark:border-primary-500/50 dark:ring-primary-500/28'
                    : 'border-stone-300/60 dark:border-slate-600/55'
                }`}
              >
                {active ? (
                  <FiLoader size={20} className="relative z-10 animate-spin text-primary-600 dark:text-primary-300" aria-hidden />
                ) : (
                  <FiImage size={21} className="relative z-10 text-stone-400 dark:text-slate-500" aria-hidden />
                )}
                <span className="absolute bottom-1 right-1 rounded bg-stone-800/78 px-1 py-0.5 text-[9px] font-medium tabular-nums text-stone-100 dark:bg-slate-950/82 dark:text-slate-100">
                  {idx + 1}/{progress.total}
                </span>
              </div>
              <div className={`${ASSISTANT_IMAGE_THUMB_META_ROW} pointer-events-none`} aria-hidden>
                <span className="invisible select-none text-[11px]">.</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ImageGeneratingPlaceholder;
