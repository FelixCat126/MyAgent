import React from 'react';
import { FiDownload, FiMaximize2, FiVideo } from 'react-icons/fi';
import type { FileInfo } from '../../types';
import type { DocumentFormat } from '../../types/document';
import { attachmentImageDisplaySrc } from '../../utils/attachmentDisplaySrc';
import { localFileProtocolUrl } from '../../utils/localFileUrl';
import { useI18n } from '../../hooks/useI18n';
import DocumentAttachmentCard, { artifactDisplayName } from './DocumentAttachmentCard';

export interface AttachmentGridProps {
  files: FileInfo[];
  tone: 'user' | 'assistant';
  onPreviewImage: (name: string, src: string, path: string, index: number) => void;
  onDownload: (e: React.MouseEvent, path: string, name: string, src?: string) => void;
  onOpen?: (path: string) => void | Promise<void>;
  exportFormats?: DocumentFormat[];
  onExport?: (format: DocumentFormat) => void | Promise<void>;
}

type IndexedFile = { file: FileInfo; index: number };

function isVideoFile(file: FileInfo): boolean {
  return file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(file.name);
}

export const AttachmentGrid: React.FC<AttachmentGridProps> = ({
  files,
  tone,
  onPreviewImage,
  onDownload,
  onOpen,
  exportFormats = [],
  onExport,
}) => {
  const { t } = useI18n();
  const isUser = tone === 'user';
  const indexed: IndexedFile[] = files.map((file, index) => ({ file, index }));

  if (isUser) {
    return (
      <div className="grid w-max max-w-full grid-cols-[repeat(4,max-content)] gap-2 justify-items-start overflow-x-auto">
        {indexed.map(({ file, index }) => {
          const isImage = file.type.startsWith('image/');
          const displaySrc = isImage ? attachmentImageDisplaySrc(file) : '';
          if (isImage && displaySrc) {
            return (
              <div key={file.path || `${file.name}-${index}`} className="flex flex-col gap-1" title={file.name}>
                <img
                  src={displaySrc}
                  alt={file.name}
                  onClick={() => onPreviewImage(file.name, displaySrc, file.path, index)}
                  className="h-[90px] w-[120px] cursor-zoom-in rounded-md border border-white/50 object-contain shadow-sm ring-1 ring-white/25 transition-transform hover:scale-[1.02] sm:h-[112px] sm:w-[150px]"
                />
                <div className="flex w-[120px] items-center gap-1 sm:w-[150px]">
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-white/95">{file.name}</span>
                  <button
                    type="button"
                    className="shrink-0 rounded p-0.5 text-white/90 hover:bg-white/15"
                    title={t('message.imagePreviewDownload')}
                    aria-label={t('message.imagePreviewDownload')}
                    onClick={(e) => onDownload(e, file.path, file.name, displaySrc)}
                  >
                    <FiDownload size={12} aria-hidden />
                  </button>
                </div>
              </div>
            );
          }
          return (
            <div
              key={file.path || `${file.name}-${index}`}
              className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-white/40 bg-white/20 px-2.5 py-1 text-[11px] font-medium text-white shadow-sm"
              title={file.name}
            >
              <span className="shrink-0 opacity-90">📎</span>
              <button
                type="button"
                className="min-w-0 truncate text-left hover:underline"
                onClick={(e) => onDownload(e, file.path, file.name)}
              >
                {file.name}
              </button>
              <button
                type="button"
                className="shrink-0 rounded p-0.5 text-white/90 hover:bg-white/15"
                title={t('message.imagePreviewDownload')}
                aria-label={t('message.imagePreviewDownload')}
                onClick={(e) => onDownload(e, file.path, file.name)}
              >
                <FiDownload size={12} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    );
  }

  const images = indexed.filter(({ file }) => file.type.startsWith('image/'));
  const videos = indexed.filter(({ file }) => isVideoFile(file));
  const documents = indexed.filter(
    ({ file }) => !file.type.startsWith('image/') && !isVideoFile(file),
  );
  const oneImage = images.length === 1;

  return (
    <div className="flex max-w-full flex-col gap-2.5">
      {images.length > 0 ? (
        <div
          className={
            oneImage
              ? 'grid w-[min(560px,68vw)] max-w-full grid-cols-1 gap-2'
              : 'grid w-[min(680px,70vw)] max-w-full grid-cols-1 gap-2 sm:grid-cols-2'
          }
        >
          {images.map(({ file, index }) => {
            const displaySrc = attachmentImageDisplaySrc(file);
            if (!displaySrc) return null;
            const displayName = artifactDisplayName(file.name, t('message.imageAlt'));
            return (
              <div
                key={file.path || `${file.name}-${index}`}
                className="group/image relative min-w-0 overflow-hidden rounded-xl border border-stone-300/70 bg-stone-100 shadow-sm dark:border-white/10 dark:bg-slate-950/45"
                title={file.name}
              >
                <button
                  type="button"
                  className={`flex w-full items-center justify-center overflow-hidden ${oneImage ? 'aspect-[4/3] max-h-[460px]' : 'aspect-[4/3]'}`}
                  onClick={() => onPreviewImage(file.name, displaySrc, file.path, index)}
                  aria-label={`${t('message.imageOpenPreview')} ${displayName}`}
                >
                  <img
                    src={displaySrc}
                    alt={displayName}
                    className="h-full w-full object-contain transition-transform duration-300 group-hover/image:scale-[1.01]"
                  />
                </button>
                <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 bg-gradient-to-t from-black/65 via-black/15 to-transparent px-3 pb-2.5 pt-10 text-white opacity-100 transition-opacity sm:opacity-0 sm:group-hover/image:opacity-100">
                  <span className="min-w-0 truncate text-[11px] font-medium text-white/90">{displayName}</span>
                  <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-white/80">
                    <FiMaximize2 size={11} aria-hidden />
                    {t('message.imageOpenPreview')}
                  </span>
                </div>
                <button
                  type="button"
                  className="absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/20 bg-black/45 text-white opacity-100 shadow-sm backdrop-blur-sm transition hover:bg-black/65 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 sm:opacity-0 sm:group-hover/image:opacity-100"
                  title={t('message.imagePreviewDownload')}
                  aria-label={`${t('message.imagePreviewDownload')} ${displayName}`}
                  onClick={(e) => onDownload(e, file.path, file.name, displaySrc)}
                >
                  <FiDownload size={15} aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      {videos.map(({ file, index }) => (
        <div
          key={file.path || `${file.name}-${index}`}
          className="flex w-[min(440px,68vw)] max-w-full flex-col gap-1.5 rounded-xl border border-stone-300/70 bg-black/45 p-2 dark:border-white/10"
        >
          <video
            src={localFileProtocolUrl(file.path)}
            controls
            preload="none"
            className="block max-h-[260px] w-full rounded-lg object-contain"
          />
          <div className="flex items-center gap-2 px-1 text-[11px] text-stone-700 dark:text-slate-300">
            <FiVideo size={12} className="shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate font-medium">{artifactDisplayName(file.name)}</span>
            <button
              type="button"
              className="rounded p-1 hover:bg-white/10"
              title={t('message.imagePreviewDownload')}
              aria-label={t('message.imagePreviewDownload')}
              onClick={(e) => onDownload(e, file.path, file.name)}
            >
              <FiDownload size={13} aria-hidden />
            </button>
          </div>
        </div>
      ))}

      {documents.length > 0 ? (
        <div className="flex max-w-full flex-col gap-2">
          {documents.map(({ file }, documentIndex) => (
            <DocumentAttachmentCard
              key={file.path || file.name}
              file={file}
              exportFormats={documentIndex === 0 ? exportFormats : []}
              onOpen={onOpen || (() => undefined)}
              onDownload={onDownload}
              onExport={documentIndex === 0 ? onExport : undefined}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
};

export default AttachmentGrid;
