import React from 'react';
import { FiDownload } from 'react-icons/fi';
import type { FileInfo } from '../../types';
import { attachmentImageDisplaySrc } from '../../utils/attachmentDisplaySrc';
import { useI18n } from '../../hooks/useI18n';
import { ASSISTANT_IMAGE_THUMB_IMG, ASSISTANT_IMAGE_THUMB_META_ROW } from './styleConstants';

/**
 * 消息附件网格项：用户气泡（白字主色底）与助手气泡（石灰/深色底）两套色调。
 * 曾是 index.tsx 内两段逐行近似的 58/69 行 JSX，仅配色不同。
 */
export interface AttachmentGridProps {
  files: FileInfo[];
  tone: 'user' | 'assistant';
  onPreviewImage: (name: string, src: string, path: string, index: number) => void;
  onDownload: (e: React.MouseEvent, path: string, name: string, src?: string) => void;
}

export const AttachmentGrid: React.FC<AttachmentGridProps> = ({
  files,
  tone,
  onPreviewImage,
  onDownload,
}) => {
  const { t } = useI18n();
  const isUser = tone === 'user';

  const downloadBtnClass = isUser
    ? 'text-white/90 hover:bg-white/15'
    : 'text-stone-600 hover:bg-stone-200 dark:text-slate-300 dark:hover:bg-slate-600';

  const renderFileDownloadButton = (file: FileInfo) => {
    if (!file.path) return null;
    const displaySrc = attachmentImageDisplaySrc(file);
    return (
      <button
        type="button"
        className={`shrink-0 rounded p-0.5 ${downloadBtnClass}`}
        title={t('message.imagePreviewDownload')}
        aria-label={t('message.imagePreviewDownload')}
        onClick={(e) => onDownload(e, file.path, file.name, displaySrc)}
      >
        <FiDownload size={12} aria-hidden />
      </button>
    );
  };

  return (
    <>
      {files.map((file, index) => {
        const isImage = file.type.startsWith('image/');
        const displaySrc = isImage ? attachmentImageDisplaySrc(file) : '';
        const canShowImage = isImage && Boolean(displaySrc);

        return (
          <div
            key={file.path || `${file.name}-${index}`}
            className="relative group/file max-w-full min-w-0 transition-all"
            title={file.name}
          >
            {canShowImage ? (
              <div className={isUser ? 'flex flex-col gap-1' : 'flex w-max flex-col gap-1'}>
                <img
                  src={displaySrc}
                  alt={file.name}
                  onClick={() =>
                    displaySrc && onPreviewImage(file.name, displaySrc, file.path, index)
                  }
                  className={
                    isUser
                      ? 'h-[90px] w-[120px] cursor-zoom-in rounded-md object-contain shadow-sm transition-transform hover:scale-[1.02] border border-white/50 ring-1 ring-white/25 sm:h-[112px] sm:w-[150px]'
                      : `${ASSISTANT_IMAGE_THUMB_IMG} bg-stone-50/80 dark:bg-slate-900/25`
                  }
                />
                <div className={isUser ? 'flex w-[120px] items-center gap-1 sm:w-[150px]' : ASSISTANT_IMAGE_THUMB_META_ROW}>
                  <span
                    className={`min-w-0 flex-1 truncate text-[11px] font-medium ${
                      isUser ? 'text-white/95' : 'text-stone-700 dark:text-slate-300'
                    }`}
                  >
                    {file.name}
                  </span>
                  <button
                    type="button"
                    className={`shrink-0 rounded p-0.5 ${downloadBtnClass}`}
                    title={t('message.imagePreviewDownload')}
                    aria-label={t('message.imagePreviewDownload')}
                    onClick={(e) => onDownload(e, file.path, file.name, displaySrc || undefined)}
                  >
                    <FiDownload size={12} aria-hidden />
                  </button>
                </div>
              </div>
            ) : (
              <div
                className={
                  isUser
                    ? 'inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-white/40 bg-white/20 px-2.5 py-1 text-[11px] font-medium text-white shadow-sm'
                    : 'inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-stone-300/70 bg-stone-200/90 px-2.5 py-1 text-[11px] font-medium text-stone-800 dark:border-white/10 dark:bg-slate-700 dark:text-slate-100'
                }
              >
                <span className="shrink-0 opacity-90">📎</span>
                <span className="min-w-0 truncate">{file.name}</span>
                {renderFileDownloadButton(file)}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
};
