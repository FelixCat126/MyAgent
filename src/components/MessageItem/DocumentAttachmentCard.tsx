import React from 'react';
import {
  FiDownload,
  FiExternalLink,
  FiFileText,
  FiMoreHorizontal,
} from 'react-icons/fi';
import type { FileInfo } from '../../types';
import type { DocumentFormat } from '../../types/document';
import { useI18n } from '../../hooks/useI18n';

const FORMAT_LABEL: Record<DocumentFormat, string> = {
  docx: 'Word',
  pdf: 'PDF',
  xlsx: 'Excel',
  md: 'Markdown',
  txt: 'TXT',
  csv: 'CSV',
};

const FORMAT_BADGE: Record<string, { label: string; tone: string }> = {
  xlsx: { label: 'XLSX', tone: 'bg-emerald-500/12 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300' },
  csv: { label: 'CSV', tone: 'bg-teal-500/12 text-teal-700 dark:bg-teal-400/15 dark:text-teal-300' },
  pdf: { label: 'PDF', tone: 'bg-rose-500/12 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300' },
  docx: { label: 'DOCX', tone: 'bg-blue-500/12 text-blue-700 dark:bg-blue-400/15 dark:text-blue-300' },
  md: { label: 'MD', tone: 'bg-violet-500/12 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300' },
  txt: { label: 'TXT', tone: 'bg-stone-500/12 text-stone-700 dark:bg-slate-400/15 dark:text-slate-300' },
};

function extensionOf(name: string): string {
  return name.match(/\.([^.]+)$/)?.[1]?.toLowerCase() || 'file';
}

/** 生成器为防覆盖追加的内部标识保留在真实文件名中，交互层不显示它。 */
export function artifactDisplayName(name: string, generatedMediaLabel?: string): string {
  const cleaned = name
    .replace(
      /\s*[（(]\s*(?:可用于|适合|用于)?\s*(?:导出|保存|下载)(?:至|为|成)?\s*(?:Excel|Word|PDF|CSV|Markdown|TXT|XLSX|DOCX)(?:\s*文件)?\s*[）)]/gi,
      '',
    )
    .replace(/\s*-[a-f0-9]{8}(?=\.[^.]+$)/i, '')
    .replace(/^\d{13}-(?=.+\.[^.]+$)/, '');

  if (generatedMediaLabel && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(\.[^.]+)$/i.test(cleaned)) {
    return cleaned.replace(/^[^.]+/, generatedMediaLabel);
  }
  return cleaned;
}

function readableSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '';
  if (size < 1024) return `${Math.round(size)} B`;
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

interface DocumentAttachmentCardProps {
  file: FileInfo;
  exportFormats?: DocumentFormat[];
  onOpen: (path: string) => void | Promise<void>;
  onDownload: (e: React.MouseEvent, path: string, name: string) => void | Promise<void>;
  onExport?: (format: DocumentFormat) => void | Promise<void>;
}

export const DocumentAttachmentCard: React.FC<DocumentAttachmentCardProps> = ({
  file,
  exportFormats = [],
  onOpen,
  onDownload,
  onExport,
}) => {
  const { t } = useI18n();
  const ext = extensionOf(file.name);
  const badge = FORMAT_BADGE[ext] || {
    label: ext.toUpperCase(),
    tone: 'bg-stone-500/12 text-stone-700 dark:bg-slate-400/15 dark:text-slate-300',
  };
  const displayName = artifactDisplayName(file.name);
  const size = readableSize(file.size);
  const subtitle = [FORMAT_LABEL[ext as DocumentFormat] || badge.label, size]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="group/document flex w-[min(460px,68vw)] max-w-full items-center gap-3 rounded-xl border border-stone-300/75 bg-white/92 p-3 shadow-sm transition-colors hover:border-stone-400 dark:border-white/10 dark:bg-slate-900/55 dark:hover:border-slate-500">
      <div className={`flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-lg ${badge.tone}`} aria-hidden>
        <FiFileText size={18} />
        <span className="mt-0.5 text-[8px] font-bold tracking-wide">{badge.label}</span>
      </div>

      <button
        type="button"
        className="min-w-0 flex-1 text-left outline-none"
        onClick={() => void onOpen(file.path)}
        title={file.name}
        aria-label={`${t('message.fileOpen')} ${displayName}`}
      >
        <span className="block truncate text-[13px] font-semibold text-stone-800 group-hover/document:text-primary-700 dark:text-slate-100 dark:group-hover/document:text-primary-300">
          {displayName}
        </span>
        <span className="mt-0.5 block text-[11px] text-stone-500 dark:text-slate-400">
          {subtitle}
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-stone-600 hover:bg-stone-100 hover:text-primary-700 dark:text-slate-300 dark:hover:bg-slate-700/80 dark:hover:text-primary-200"
          onClick={() => void onOpen(file.path)}
          title={t('message.fileOpen')}
          aria-label={`${t('message.fileOpen')} ${displayName}`}
        >
          <FiExternalLink size={13} aria-hidden />
          <span className="hidden sm:inline">{t('message.fileOpen')}</span>
        </button>
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1 rounded-lg bg-primary-500/10 px-2 text-[11px] font-semibold text-primary-700 hover:bg-primary-500/18 dark:bg-primary-400/12 dark:text-primary-200 dark:hover:bg-primary-400/20"
          onClick={(e) => void onDownload(e, file.path, file.name)}
          title={t('message.imagePreviewDownload')}
          aria-label={`${t('message.imagePreviewDownload')} ${displayName}`}
        >
          <FiDownload size={13} aria-hidden />
          <span className="hidden sm:inline">{t('message.imagePreviewDownload')}</span>
        </button>
        {onExport && exportFormats.length > 0 ? (
          <details className="relative">
            <summary
              className="flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-lg text-stone-500 hover:bg-stone-100 hover:text-stone-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 dark:text-slate-400 dark:hover:bg-slate-700/80 dark:hover:text-slate-100 [&::-webkit-details-marker]:hidden"
              title={t('message.fileMore')}
              aria-label={t('message.fileMore')}
            >
              <FiMoreHorizontal size={16} aria-hidden />
            </summary>
            <div className="absolute right-0 top-10 z-30 w-36 overflow-hidden rounded-lg border border-stone-200 bg-white py-1 shadow-xl dark:border-slate-600 dark:bg-slate-800">
              <p className="px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-stone-400 dark:text-slate-500">
                {t('message.fileExportAs')}
              </p>
              {exportFormats.map((format) => (
                <button
                  key={format}
                  type="button"
                  className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-stone-700 hover:bg-stone-100 dark:text-slate-200 dark:hover:bg-slate-700"
                  onClick={(e) => {
                    const details = e.currentTarget.closest('details');
                    details?.removeAttribute('open');
                    void onExport(format);
                  }}
                >
                  <span>{FORMAT_LABEL[format]}</span>
                  <FiDownload size={12} className="opacity-55" aria-hidden />
                </button>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
};

export default DocumentAttachmentCard;
