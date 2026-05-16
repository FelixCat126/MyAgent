import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pathToFileURL } from 'url';
import { FileInfo, Message } from '../types';
import { FiMessageSquare, FiCopy, FiDownload, FiChevronDown, FiChevronRight, FiChevronLeft, FiX, FiFileText, FiLoader, FiTrash2, FiImage, FiEdit2, FiCheckSquare, FiSquare, FiCheck } from 'react-icons/fi';
import { useI18n } from '../hooks/useI18n';
import MarkdownContent from './MarkdownContent';
import { markdownContainsPipeTable } from '../utils/markdownTableDetect';
import { looksLikeStandaloneCodeSnippet } from '../utils/standaloneCodeDetect';
import { stripGenerateImageArtifactsForDisplay } from '../utils/toolCalls';
import {
  findConversationGalleryIndex,
  type ConversationImageGalleryItem,
} from '@/utils/conversationImageGallery';
import { DownloadLocalFileError, downloadDisplayImage } from '@/utils/imageDownload';

const MAX_MARKDOWN_RENDER_CHARS = 24_000;
const MAX_ASSISTANT_PREPROCESS_CHARS = 28_000;

/** 多图附件与生图占位共用：每行 4 张，不足一行从左排，超过 4 自动换行；缩略尺寸一致避免生成前后跳动 */
const MULTI_IMAGE_ATTACHMENT_GRID =
  'grid w-max max-w-full grid-cols-[repeat(4,max-content)] gap-2 justify-items-start overflow-x-auto';

const ASSISTANT_IMAGE_THUMB_FRAME =
  'h-[90px] w-[120px] shrink-0 sm:h-[112px] sm:w-[150px]';

const ASSISTANT_IMAGE_THUMB_IMG =
  `${ASSISTANT_IMAGE_THUMB_FRAME} cursor-zoom-in rounded-md object-contain border border-stone-300/60 shadow-sm transition-transform hover:scale-[1.02] dark:border-white/10`;

const ASSISTANT_IMAGE_THUMB_META_ROW =
  'flex min-h-[calc(15px+0.125rem)] w-[120px] items-center gap-1 sm:w-[150px]';

/** 对应 App.tsx 顶栏拖拽区 TITLEBAR_H(44)，避免按钮落在 Electron drag 带上被吞点击 */
const MODAL_CLEAR_TITLEBAR_PT = 'pt-[52px]';

const MODAL_PORTAL_LAYER_CLASS = 'fixed inset-0 z-[10010] flex items-center justify-center bg-black/70 backdrop-blur-sm transition-opacity';

const modalPortalShellStyle: React.CSSProperties & { WebkitAppRegion?: string } = {
  WebkitAppRegion: 'no-drag',
};

/** 预览大图：启用系统长按菜单（存储图像等）；WebKit 专有属性 */
const previewImgTouchMenuStyle: React.CSSProperties = {
  WebkitTouchCallout: 'default',
  WebkitUserSelect: 'none',
  userSelect: 'none',
};

interface MessageItemProps {
  message: Message;
  onEdit?: (message: Message) => void;
  editing?: boolean;
  onSubmitEdit?: (message: Message, content: string) => void;
  onCancelEdit?: () => void;
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (messageId: string) => void;
  onStartSelect?: (messageId: string) => void;
  /** 会话是否仍处于流式生成中（由 ChatWindow 传入） */
  conversationStreaming?: boolean;
  /** 当前流式输出绑定的助手消息 id */
  streamingAssistantId?: string | null;
  /** 流式已开始输出思考且正文仍未到时，在主气泡内显示「···」（避免下方再出现一个气泡） */
  showInlineStreamPlaceholder?: boolean;
  /** 当前会话内全部可预览图片（用于大图左右切换） */
  conversationGallery?: ConversationImageGalleryItem[];
  /** 在会话级画廊中打开指定附件（messageId + 该消息 files 数组下标） */
  onOpenConversationGallery?: (messageId: string, fileIndex: number) => void;
  imageGenProgress?: { current: number; total: number } | null;
}

function InlineStreamDots() {
  return (
    <div className="flex gap-1 text-stone-500 dark:text-slate-500 text-sm" aria-hidden>
      <span className="animate-bounce" style={{ animationDelay: '0ms' }}>
        ·
      </span>
      <span className="animate-bounce" style={{ animationDelay: '150ms' }}>
        ·
      </span>
      <span className="animate-bounce" style={{ animationDelay: '300ms' }}>
        ·
      </span>
    </div>
  );
}

function DocumentGeneratingPlaceholder({ t }: { t: (key: string) => string }) {
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
}

function ImageGeneratingPlaceholder({
  progress,
  files,
  openAttachmentPreview,
  downloadAttachmentCopy,
  t,
}: {
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
}) {
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
            const hasPreview = file.preview && file.preview.startsWith('data:');
            const displaySrc = hasPreview
              ? file.preview
              : file.path
                ? pathToFileURL(file.path).href.replace(/^file:/i, 'local-file:')
                : '';
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
}

function extractDocumentExportBody(raw: string): string {
  const text = String(raw || '').replace(/\r\n/g, '\n').trim();
  if (!text) return text;

  const fenced = text.match(/```(?:markdown|md|document|docx|word)?\s*\n([\s\S]*?)\n```/i);
  if (fenced?.[1]?.trim()) return fenced[1].trim();

  const bodyMarker = text.match(/(?:^|\n)(?:正文|文档正文|以下为(?:文档|正文)|文稿内容)\s*[:：]\s*\n([\s\S]*)/);
  if (bodyMarker?.[1]?.trim()) return bodyMarker[1].trim();

  const heading = text.search(/^#{1,3}\s+\S/m);
  if (heading > 0) return text.slice(heading).trim();

  return text;
}

function AssistantReasoningCollapsible(props: {
  reasoning: string;
  isThoughtStreaming: boolean;
  t: (key: string) => string;
}) {
  const { reasoning, isThoughtStreaming, t } = props;
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollFollowRaf = useRef(0);

  useEffect(() => {
    if (!isThoughtStreaming) setExpanded(false);
  }, [isThoughtStreaming]);

  const showBody = isThoughtStreaming || expanded;

  const handleToggle = () => {
    if (isThoughtStreaming) return;
    setExpanded((v) => !v);
  };

  useEffect(() => {
    if (!showBody) return;
    if (scrollFollowRaf.current !== 0) window.cancelAnimationFrame(scrollFollowRaf.current);
    scrollFollowRaf.current = window.requestAnimationFrame(() => {
      scrollFollowRaf.current = 0;
      const el = scrollRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    });
    return () => {
      if (scrollFollowRaf.current !== 0) window.cancelAnimationFrame(scrollFollowRaf.current);
    };
  }, [reasoning, showBody]);

  return (
    <div
      className={
        (showBody ? 'mb-2 border-b border-stone-200/80 pb-2.5 ' : 'mb-1.5 ') +
        'dark:border-slate-600/45 text-stone-700 dark:text-slate-300'
      }
    >
      <button
        type="button"
        disabled={isThoughtStreaming}
        onClick={handleToggle}
        className={`flex w-full items-center gap-1.5 -mx-0.5 px-0.5 py-1 text-left text-[11px] font-medium text-stone-600 dark:text-slate-400 ${
          isThoughtStreaming ? 'cursor-default' : 'cursor-pointer hover:text-stone-800 dark:hover:text-slate-200'
        }`}
        aria-expanded={showBody}
      >
        {showBody ? (
          <FiChevronDown size={14} className="shrink-0 opacity-80" aria-hidden />
        ) : (
          <FiChevronRight size={14} className="shrink-0 opacity-80" aria-hidden />
        )}
        <span className="min-w-0 flex-1">{t('chat.reasoningSection')}</span>
        <span className="shrink-0 text-[10px] font-normal opacity-75 tabular-nums">
          {isThoughtStreaming ? t('chat.reasoningStreaming') : showBody ? t('chat.reasoningCollapse') : t('chat.reasoningExpand')}
        </span>
      </button>
      {showBody ? (
        <div
          ref={scrollRef}
          className="mt-1 max-h-[min(22vh,140px)] overflow-y-auto overflow-x-hidden rounded-md bg-stone-200/35 px-2 py-1.5 dark:bg-slate-900/50"
        >
          <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-stone-800 dark:text-slate-200">
            {reasoning}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

export const ImagePreviewModal: React.FC<{
  src: string;
  onClose: () => void;
  alt: string;
  /** 保留供调用方语义一致；大图保存请使用长按系统菜单 */
  localPath?: string;
  defaultFileName?: string;
}> = ({ src, onClose, alt }) => {
  const { t } = useI18n();

  const node = (
    <div
      className={MODAL_PORTAL_LAYER_CLASS}
      style={modalPortalShellStyle}
      onClick={onClose}
    >
      <div
        className="relative isolate flex max-h-[85vh] w-full max-w-[90vw] flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pointer-events-auto relative z-[210] flex shrink-0 justify-end gap-3 [&_svg]:pointer-events-none">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-md bg-white/10 px-2 py-1 text-white backdrop-blur-sm transition-colors hover:bg-white/20 hover:text-primary-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/55"
            title={t('message.closePreview')}
            aria-label={t('message.closePreview')}
          >
            <FiX size={18} aria-hidden />
          </button>
        </div>
        <img
          src={src}
          alt={alt}
          style={previewImgTouchMenuStyle}
          className="relative z-0 mx-auto block max-h-[min(calc(85vh-120px),80vh)] max-w-full object-contain rounded-lg shadow-2xl"
        />
        <p className="mx-auto max-w-[min(90vw,24rem)] text-center text-[11px] leading-snug text-white/55 px-2">
          {t('message.imageLongPressGalleryHint')}
        </p>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(node, document.body) : null;
};

export const ConversationImageGalleryModal: React.FC<{
  slides: ConversationImageGalleryItem[];
  startIndex: number;
  onClose: () => void;
  onDeleteCurrent?: (slide: ConversationImageGalleryItem) => void | Promise<void>;
}> = ({ slides, startIndex, onClose, onDeleteCurrent }) => {
  const { t } = useI18n();
  const [idx, setIdx] = useState(() =>
    slides.length ? Math.min(Math.max(0, startIndex), slides.length - 1) : 0
  );

  useEffect(() => {
    setIdx((i) => Math.min(i, Math.max(0, slides.length - 1)));
  }, [slides.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setIdx((i) => Math.max(0, i - 1));
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setIdx((i) => Math.min(slides.length - 1, i + 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [slides.length, onClose]);

  if (!slides.length) return null;

  const slide = slides[idx]!;
  const canPrev = idx > 0;
  const canNext = idx < slides.length - 1;

  const node = (
    <div
      className={MODAL_PORTAL_LAYER_CLASS}
      style={modalPortalShellStyle}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t('message.imageAlt')}
    >
      <div
        className="relative isolate flex h-full max-h-screen min-h-0 w-full max-w-[100vw] flex-col px-12 sm:px-16"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className={`pointer-events-auto relative z-[210] flex w-full shrink-0 justify-end gap-3 pb-4 [&_svg]:pointer-events-none sm:pb-5 ${MODAL_CLEAR_TITLEBAR_PT}`}
        >
          {onDeleteCurrent ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md bg-red-500/20 px-2.5 py-1 text-sm text-white backdrop-blur-sm transition-colors hover:bg-red-500/35 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/55"
              title={t('imageLibrary.delete')}
              onClick={(e) => {
                e.stopPropagation();
                void onDeleteCurrent(slide);
              }}
            >
              <FiTrash2 size={14} aria-hidden />
              <span>{t('imageLibrary.delete')}</span>
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-md bg-white/10 px-2 py-1 text-white backdrop-blur-sm transition-colors hover:bg-white/20 hover:text-primary-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/55"
            title={t('message.closePreview')}
            aria-label={t('message.closePreview')}
          >
            <FiX size={18} aria-hidden />
          </button>
        </div>

        <div className="pointer-events-none relative z-0 flex min-h-0 w-full max-w-[min(96vw,1400px)] flex-1 items-center justify-center gap-1 self-center sm:gap-2">
          <button
            type="button"
            disabled={!canPrev}
            onClick={(e) => {
              e.stopPropagation();
              setIdx((i) => Math.max(0, i - 1));
            }}
            className={`pointer-events-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/25 bg-white/10 text-white transition-colors sm:h-12 sm:w-12 [&_svg]:pointer-events-none ${
              canPrev ? 'hover:bg-white/20' : 'cursor-not-allowed opacity-35'
            }`}
            title={t('message.imageGalleryPrev')}
            aria-label={t('message.imageGalleryPrev')}
          >
            <FiChevronLeft size={22} aria-hidden />
          </button>

          <div className="pointer-events-auto flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3">
            <img
              src={slide.src}
              alt={slide.defaultFileName || t('message.imageAlt')}
              style={previewImgTouchMenuStyle}
              className="max-h-[min(72vh,880px)] max-w-full object-contain rounded-lg shadow-2xl"
            />
            <p className="text-center text-sm text-white/90 tabular-nums">
              {t('message.imageGalleryPosition', { current: idx + 1, total: slides.length })}
            </p>
            <p className="mx-auto max-w-[min(90vw,24rem)] text-center text-[11px] leading-snug text-white/55 px-2">
              {t('message.imageLongPressGalleryHint')}
            </p>
          </div>

          <button
            type="button"
            disabled={!canNext}
            onClick={(e) => {
              e.stopPropagation();
              setIdx((i) => Math.min(slides.length - 1, i + 1));
            }}
            className={`pointer-events-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/25 bg-white/10 text-white transition-colors sm:h-12 sm:w-12 [&_svg]:pointer-events-none ${
              canNext ? 'hover:bg-white/20' : 'cursor-not-allowed opacity-35'
            }`}
            title={t('message.imageGalleryNext')}
            aria-label={t('message.imageGalleryNext')}
          >
            <FiChevronRight size={22} aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(node, document.body) : null;
};

function formatMessageTime(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const MessageItem: React.FC<MessageItemProps> = ({
  message,
  onEdit,
  editing = false,
  onSubmitEdit,
  onCancelEdit,
  selectionMode = false,
  selected = false,
  onToggleSelect,
  onStartSelect,
  conversationStreaming = false,
  streamingAssistantId = null,
  showInlineStreamPlaceholder = false,
  conversationGallery,
  onOpenConversationGallery,
  imageGenProgress,
}) => {
  const { t } = useI18n();
  const isUser = message.role === 'user';
  const [draftContent, setDraftContent] = useState(message.content ?? '');
  const [preview, setPreview] = useState<{
    src: string;
    localPath?: string;
    defaultFileName?: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (editing) setDraftContent(message.content ?? '');
  }, [editing, message.content]);

  const openAttachmentPreview = (
    fileName: string,
    displaySrc: string,
    localPath: string,
    fileIndex: number
  ) => {
    if (!displaySrc) return;
    const gIdx =
      conversationGallery && onOpenConversationGallery
        ? findConversationGalleryIndex(conversationGallery, message.id, fileIndex)
        : -1;
    if (gIdx >= 0) {
      onOpenConversationGallery!(message.id, fileIndex);
      return;
    }
    setPreview({ src: displaySrc, localPath, defaultFileName: fileName });
  };

  const downloadAttachmentCopy = async (
    e: React.MouseEvent,
    localPath: string,
    fileName: string,
    displaySrc?: string
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const src =
      (displaySrc && displaySrc.trim()) ||
      ((localPath || '').trim() ?
        pathToFileURL(localPath).href.replace(/^file:/i, 'local-file:')
      : '');
    try {
      await downloadDisplayImage({
        src,
        sourceLocalPath: (localPath || '').trim(),
        defaultFileName: fileName || 'image.png',
      });
    } catch (err) {
      if (err instanceof DownloadLocalFileError) {
        window.alert(
          t(
            err.code === 'path_empty'
              ? 'message.downloadPathEmpty'
              : 'message.downloadSourceMissing'
          )
        );
        return;
      }
      console.warn('[image-download] failed', fileName);
      window.alert(t('message.imageDownloadFailed'));
    }
  };

  const renderFileDownloadButton = (file: FileInfo) => {
    if (!file.path) return null;
    const displaySrc =
      file.preview && file.preview.startsWith('data:')
        ? file.preview
        : pathToFileURL(file.path).href.replace(/^file:/i, 'local-file:');

    return (
      <button
        type="button"
        className={`shrink-0 rounded p-0.5 ${
          isUser
            ? 'text-white/90 hover:bg-white/15'
            : 'text-stone-600 hover:bg-stone-200 dark:text-slate-300 dark:hover:bg-slate-600'
        }`}
        title={t('message.imagePreviewDownload')}
        aria-label={t('message.imagePreviewDownload')}
        onClick={(e) => void downloadAttachmentCopy(e, file.path, file.name, displaySrc)}
      >
        <FiDownload size={12} aria-hidden />
      </button>
    );
  };

  const isThoughtStreaming =
    message.role === 'assistant' &&
    conversationStreaming &&
    !!streamingAssistantId &&
    message.id === streamingAssistantId;

  /** 流式输出的助手正文：禁用 strip + Markdown，避免半截 JSON/remark-gfm 把界面卡死 */
  const skipHeavyAssistantMutationsDuringStream =
    message.role === 'assistant' &&
    Boolean(conversationStreaming) &&
    streamingAssistantId != null &&
    streamingAssistantId === message.id;

  const assistantDisplayBody = useMemo(
    () => {
      if (message.role !== 'assistant') return '';
      const raw = message.content ?? '';
      const capped =
        raw.length > MAX_ASSISTANT_PREPROCESS_CHARS
          ? `${raw.slice(0, MAX_ASSISTANT_PREPROCESS_CHARS)}\n\n[内容过长，已截断显示；复制按钮仍会复制完整内容]`
          : raw;
      if (skipHeavyAssistantMutationsDuringStream) return capped;
      return stripGenerateImageArtifactsForDisplay(capped);
    },
    [message.role, message.id, message.content, conversationStreaming, streamingAssistantId]
  );
  const assistantExportBody = useMemo(
    () => {
      if (message.role !== 'assistant') return '';
      const raw = message.content ?? '';
      if (
        conversationStreaming &&
        streamingAssistantId != null &&
        streamingAssistantId === message.id
      ) {
        const capped =
          raw.length > MAX_ASSISTANT_PREPROCESS_CHARS
            ? `${raw.slice(0, MAX_ASSISTANT_PREPROCESS_CHARS)}\n\n[内容过长，已截断显示；复制按钮仍会复制完整内容]`
            : raw;
        return capped;
      }
      return stripGenerateImageArtifactsForDisplay(raw);
    },
    [message.role, message.id, message.content, conversationStreaming, streamingAssistantId]
  );

  const handleCopy = async () => {
    const text =
      message.role === 'user'
        ? (message.content ?? '')
        : stripGenerateImageArtifactsForDisplay(message.content ?? '');
    try {
      await window.electron.setClipboardText(text);
      setCopied(true);
      return;
    } catch (electronError) {
      console.warn('Electron 剪贴板复制失败，尝试浏览器剪贴板', electronError);
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch (e) {
      console.warn('复制失败', e);
    }
  };

  const handleSaveExport = async (format: 'md' | 'xlsx' | 'docx') => {
    const raw = message.role === 'assistant' ? assistantExportBody : (message.content ?? '');
    const content = format === 'xlsx' ? raw : extractDocumentExportBody(raw);
    const safe = String(content).slice(0, 40).replace(/[\\/:"*?<>|\r\n]/g, '_');
    const base = safe || `reply-${message.timestamp}`;
    await window.electron.saveAssistantExport({
      format,
      content,
      defaultBaseName: base,
    });
  };

  const standaloneCode =
    message.role !== 'user' &&
    !(message.files && message.files.length > 0) &&
    looksLikeStandaloneCodeSnippet(assistantDisplayBody);
  const showDocumentGeneratingPlaceholder =
    message.role === 'assistant' &&
    message.exportHint?.document &&
    message.exportHint.status === 'generating' &&
    !message.files?.length;
  const hideBodyForDocumentThinking =
    message.role === 'assistant' &&
    message.exportHint?.document &&
    message.exportHint.status === 'thinking' &&
    !message.files?.length &&
    !assistantDisplayBody.trim();
  const reasoningTrimmed = (message.reasoning ?? '').trim();
  const hasReasoningContent = reasoningTrimmed.length > 0;
  const showDocDraftingTerminalStripe = hideBodyForDocumentThinking && !hasReasoningContent;
  const mergedImageGenProgress = imageGenProgress ?? message.imageGenProgress;
  const showImageGeneratingPlaceholder =
    message.role === 'assistant' && mergedImageGenProgress != null;
  /** 深色「终端」条仅承载文档起草/写入，与生图占位分离 */
  const assistantDocTerminalActive =
    showDocumentGeneratingPlaceholder || showDocDraftingTerminalStripe;
  const markdownBody =
    assistantDisplayBody.length > MAX_MARKDOWN_RENDER_CHARS
      ? `${assistantDisplayBody.slice(0, MAX_MARKDOWN_RENDER_CHARS)}\n\n[内容过长，已截断显示；复制按钮仍会复制完整内容]`
      : assistantDisplayBody;
  const hasExportableAssistantText =
    message.role === 'assistant' && !showInlineStreamPlaceholder && assistantExportBody.trim().length > 0;
  const hasMarkdownTable = assistantExportBody.trim().length > 0 && markdownContainsPipeTable(assistantExportBody);
  const documentExportFormats = message.exportHint?.document ? message.exportHint.formats ?? ['md', 'docx'] : [];
  const showMdExport = documentExportFormats.includes('md');
  const showDocxExport = documentExportFormats.includes('docx');
  const showExportPanel =
    !standaloneCode &&
    hasExportableAssistantText &&
    !showDocumentGeneratingPlaceholder &&
    !showImageGeneratingPlaceholder &&
    !(message.exportHint?.document && message.files?.length) &&
    (hasMarkdownTable || showMdExport || showDocxExport);

  /** 以上为助手展示/导出正文（已剔除生图工具 JSON） */

  return (
    <>
      <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} group mb-4`}>
        {selectionMode ? (
          <button
            type="button"
            onClick={() => onToggleSelect?.(message.id)}
            className={`mt-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors ${
              isUser ? 'mr-2' : 'mr-2'
            } ${
              selected
                ? 'text-primary-600 dark:text-primary-300'
                : 'text-stone-400 hover:bg-stone-200 hover:text-stone-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200'
            }`}
            title={t('message.selectTitle')}
            aria-label={t('message.selectTitle')}
          >
            {selected ? <FiCheckSquare size={17} /> : <FiSquare size={17} />}
          </button>
        ) : null}
        {isUser ? (
          <div className="flex w-fit max-w-[80%] flex-col gap-1.5">
            <div className="flex flex-row-reverse items-start gap-3">
              {/** 用户头像：与气泡同系的青绿圆底 + 聊天图标，水平镜像以与 AI 区对称；与应用 Dock 主图标无关 */}
              <div
                className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary-500 to-teal-600 text-white shadow-sm -scale-x-100"
                title={t('message.user')}
                role="img"
                aria-label={t('message.user')}
              >
                <FiMessageSquare size={16} aria-hidden />
              </div>
              <div className="flex min-w-0 max-w-full flex-col items-stretch">
                <div
                  className={`px-5 py-3.5 rounded-2xl shadow-sm leading-relaxed max-w-full min-w-0
                  bg-gradient-to-br from-primary-500 to-primary-600 text-white rounded-tr-sm border border-primary-400/30`}
                >
                  {message.files && message.files.length > 0 && (
                    <div className={`mb-2 ${MULTI_IMAGE_ATTACHMENT_GRID}`}>
                      {message.files.map((file, index) => {
                        const isImage = file.type.startsWith('image/');
                        const hasPreview = file.preview && file.preview.startsWith('data:');
                        const displaySrc = hasPreview
                          ? file.preview
                          : isImage
                            ? pathToFileURL(file.path).href.replace(/^file:/i, 'local-file:')
                            : '';
                        const canShowImage = isImage && (hasPreview || file.path);

                        return (
                          <div
                            key={index}
                            className="relative group/file max-w-full min-w-0 transition-all"
                            title={file.name}
                          >
                            {canShowImage ? (
                              <div className="flex flex-col gap-1">
                                <img
                                  src={displaySrc}
                                  alt={file.name}
                                  onClick={() =>
                                    displaySrc &&
                                    openAttachmentPreview(file.name, displaySrc, file.path, index)
                                  }
                                  className="h-[90px] w-[120px] cursor-zoom-in rounded-md object-contain shadow-sm transition-transform hover:scale-[1.02] border border-white/50 ring-1 ring-white/25 sm:h-[112px] sm:w-[150px]"
                                />
                                <div className="flex w-[120px] items-center gap-1 sm:w-[150px]">
                                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-white/95">
                                    {file.name}
                                  </span>
                                  <button
                                    type="button"
                                    className="shrink-0 rounded p-0.5 text-white/90 hover:bg-white/15"
                                    title={t('message.imagePreviewDownload')}
                                    aria-label={t('message.imagePreviewDownload')}
                                    onClick={(e) =>
                                      void downloadAttachmentCopy(
                                        e,
                                        file.path,
                                        file.name,
                                        displaySrc || undefined
                                      )
                                    }
                                  >
                                    <FiDownload size={12} aria-hidden />
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-white/40 bg-white/20 px-2.5 py-1 text-[11px] font-medium text-white shadow-sm">
                                <span className="shrink-0 opacity-90">📎</span>
                                <span className="min-w-0 truncate">{file.name}</span>
                                {renderFileDownloadButton(file)}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {editing ? (
                    <div className="flex min-w-[min(420px,70vw)] flex-col gap-2">
                      <textarea
                        value={draftContent}
                        onChange={(e) => setDraftContent(e.target.value)}
                        className="min-h-[5.5rem] w-full resize-y rounded-lg border border-white/45 bg-white/95 px-3 py-2 text-sm leading-relaxed text-stone-900 shadow-inner outline-none focus:border-white focus:ring-2 focus:ring-white/55 dark:bg-slate-950/95 dark:text-slate-50"
                        autoFocus
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={onCancelEdit}
                          className="rounded-md bg-white/15 px-2.5 py-1 text-xs font-medium text-white hover:bg-white/25"
                        >
                          {t('chat.cancelEdit')}
                        </button>
                        <button
                          type="button"
                          disabled={!draftContent.trim()}
                          onClick={() => onSubmitEdit?.(message, draftContent)}
                          className="rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-primary-700 shadow-sm hover:bg-primary-50 disabled:cursor-not-allowed disabled:opacity-55"
                        >
                          {t('chat.send')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="whitespace-pre-wrap text-sm break-words">{message.content}</div>
                  )}
                </div>
                {/** 与气泡同宽；日期最右，复制/重发在左、悬停显示 */}
                <div className="mt-1.5 flex w-full min-w-0 items-center justify-end gap-2 text-[10px] text-stone-500/85 dark:text-slate-500">
                  <div className="flex min-w-0 items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      onClick={handleCopy}
                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-stone-200/80 hover:text-primary-500 dark:hover:bg-slate-800"
                      type="button"
                    title={t('message.copyTitle')}
                    aria-label={t('message.copyTitle')}
                  >
                      {copied ? <FiCheck size={13} className="text-emerald-500" /> : <FiCopy size={12} />}
                    </button>
                    {onEdit && !selectionMode && !editing ? (
                      <button
                        onClick={() => onEdit(message)}
                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-stone-200/80 hover:text-primary-500 dark:hover:bg-slate-800"
                        type="button"
                        title={t('message.editTitle')}
                        aria-label={t('message.editTitle')}
                      >
                        <FiEdit2 size={12} />
                      </button>
                    ) : null}
                    {!selectionMode ? (
                      <button
                        onClick={() => onStartSelect?.(message.id)}
                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-stone-200/80 hover:text-primary-500 dark:hover:bg-slate-800"
                        type="button"
                        title={t('message.selectTitle')}
                        aria-label={t('message.selectTitle')}
                      >
                        <FiCheckSquare size={12} />
                      </button>
                    ) : null}
                  </div>
                  <span className="shrink-0 tabular-nums text-right">{formatMessageTime(message.timestamp)}</span>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex max-w-[80%] flex-row">
            <div className="mr-3 mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-sm">
              <FiMessageSquare size={16} />
            </div>
            <div className="flex min-w-0 max-w-full flex-1 flex-col items-stretch">
              <div className="max-w-full rounded-2xl rounded-tl-sm border border-stone-300/45 bg-stone-100 px-5 py-3.5 text-stone-800 shadow-sm leading-relaxed dark:border-white/5 dark:bg-slate-800 dark:text-slate-100">
                {hasReasoningContent ? (
                  <AssistantReasoningCollapsible
                    reasoning={message.reasoning ?? ''}
                    isThoughtStreaming={isThoughtStreaming}
                    t={t}
                  />
                ) : null}
                {assistantDocTerminalActive ? (
                  <div className="assistant-stream-terminal mb-3 space-y-3 overflow-hidden rounded-lg border border-emerald-900/38 bg-[#070b10] px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] dark:border-emerald-500/26">
                    {showDocDraftingTerminalStripe ? (
                      <p className="m-0 text-[11px] leading-relaxed text-stone-400 dark:text-slate-500" role="status">
                        {t('chat.documentDraftingTerminal')}
                      </p>
                    ) : null}
                    {showDocumentGeneratingPlaceholder ? <DocumentGeneratingPlaceholder t={t} /> : null}
                  </div>
                ) : null}
                {showInlineStreamPlaceholder ? (
                  <div className="pt-0.5">
                    <InlineStreamDots />
                  </div>
                ) : null}
                {skipHeavyAssistantMutationsDuringStream &&
                  !showInlineStreamPlaceholder &&
                  !hideBodyForDocumentThinking ? (
                  <div className="max-w-full whitespace-pre-wrap break-words pt-0.5 text-[13px] leading-relaxed text-stone-800 dark:text-slate-100">
                    {markdownBody}
                  </div>
                ) : standaloneCode ? (
                  <div className="overflow-hidden rounded-lg border border-stone-300/60 bg-[#faf8f5] shadow-inner dark:border-slate-600/50 dark:bg-slate-900/90">
                    <div className="flex items-center justify-between border-b border-stone-300/50 bg-stone-200/85 px-3 py-1.5 text-[11px] text-stone-600 dark:border-slate-600/50 dark:bg-slate-800/90 dark:text-slate-400">
                      <span className="font-medium opacity-90">{t('message.codeSnippetBadge')}</span>
                      <button
                        type="button"
                        className="rounded px-2 py-0.5 font-medium text-primary-700 hover:bg-white/70 dark:text-primary-300 dark:hover:bg-slate-700/85"
                        title={t('message.copyCodeBlock')}
                        onClick={() => void handleCopy()}
                      >
                        {t('message.copyCodeBlock')}
                      </button>
                    </div>
                    <pre className="m-0 max-h-[min(70vh,520px)] overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[13px] leading-relaxed text-stone-900 dark:text-slate-100">
                      {assistantDisplayBody}
                    </pre>
                  </div>
                ) : showInlineStreamPlaceholder || hideBodyForDocumentThinking ? null : (
                  <MarkdownContent text={markdownBody} copyCodeLabel={t('message.copyCodeBlock')} />
                )}
                {showExportPanel ? (
                  <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-stone-200/80 pt-2.5 dark:border-slate-600/50">
                    <p className="m-0 inline-flex min-h-[1.625rem] items-center text-[10px] leading-snug text-stone-500 dark:text-slate-400">
                      {message.exportHint?.document ? t('chat.exportDocumentHint') : t('chat.exportStripHint')}
                    </p>
                    {showMdExport ? (
                      <button
                        type="button"
                        onClick={() => void handleSaveExport('md')}
                        className="inline-flex items-center gap-1 rounded-md border border-stone-300/60 bg-white/60 px-2 py-1 text-[10px] font-medium text-stone-600 hover:bg-stone-100 dark:border-slate-600 dark:bg-slate-700/50 dark:text-slate-200 dark:hover:bg-slate-600"
                      >
                        <FiDownload size={11} />
                        {t('chat.downloadMd')}
                      </button>
                    ) : null}
                    {hasMarkdownTable ? (
                      <button
                        type="button"
                        onClick={() => void handleSaveExport('xlsx')}
                        className="inline-flex items-center gap-1 rounded-md border border-stone-300/60 bg-white/60 px-2 py-1 text-[10px] font-medium text-stone-600 hover:bg-stone-100 dark:border-slate-600 dark:bg-slate-700/50 dark:text-slate-200 dark:hover:bg-slate-600"
                      >
                        <FiDownload size={11} />
                        {t('chat.downloadXlsx')}
                      </button>
                    ) : null}
                    {showDocxExport ? (
                      <button
                        type="button"
                        onClick={() => void handleSaveExport('docx')}
                        className="inline-flex items-center gap-1 rounded-md border border-stone-300/60 bg-white/60 px-2 py-1 text-[10px] font-medium text-stone-600 hover:bg-stone-100 dark:border-slate-600 dark:bg-slate-700/50 dark:text-slate-200 dark:hover:bg-slate-600"
                      >
                        <FiDownload size={11} />
                        {t('chat.downloadDocx')}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {showImageGeneratingPlaceholder && mergedImageGenProgress ? (
                  <div className="mt-3">
                    <ImageGeneratingPlaceholder
                      progress={mergedImageGenProgress}
                      files={message.files}
                      openAttachmentPreview={openAttachmentPreview}
                      downloadAttachmentCopy={downloadAttachmentCopy}
                      t={t}
                    />
                  </div>
                ) : null}
                {message.files && message.files.length > 0 && !showImageGeneratingPlaceholder && (
                  <div
                    className={
                      !(showInlineStreamPlaceholder ||
                        standaloneCode ||
                        markdownBody.trim() ||
                        (isThoughtStreaming || (message.reasoning ?? '').trim().length > 0))
                        ? ''
                        : 'mt-3'
                    }
                  >
                    <div className={MULTI_IMAGE_ATTACHMENT_GRID}>
                      {message.files.map((file, index) => {
                        const isImage = file.type.startsWith('image/');
                        const hasPreview = file.preview && file.preview.startsWith('data:');
                        const displaySrc = hasPreview
                          ? file.preview
                          : isImage
                            ? pathToFileURL(file.path).href.replace(/^file:/i, 'local-file:')
                            : '';
                        const canShowImage = isImage && (hasPreview || file.path);

                        return (
                          <div
                            key={index}
                            className="relative group/file max-w-full min-w-0 transition-all"
                            title={file.name}
                          >
                            {canShowImage ? (
                              <div className="flex w-max flex-col gap-1">
                                <img
                                  src={displaySrc}
                                  alt={file.name}
                                  onClick={() =>
                                    displaySrc &&
                                    openAttachmentPreview(file.name, displaySrc, file.path, index)
                                  }
                                  className={`${ASSISTANT_IMAGE_THUMB_IMG} bg-stone-50/80 dark:bg-slate-900/25`}
                                />
                                <div className={ASSISTANT_IMAGE_THUMB_META_ROW}>
                                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-stone-700 dark:text-slate-300">
                                    {file.name}
                                  </span>
                                  <button
                                    type="button"
                                    className="shrink-0 rounded p-0.5 text-stone-600 hover:bg-stone-200 dark:text-slate-300 dark:hover:bg-slate-600"
                                    title={t('message.imagePreviewDownload')}
                                    aria-label={t('message.imagePreviewDownload')}
                                    onClick={(e) =>
                                      void downloadAttachmentCopy(
                                        e,
                                        file.path,
                                        file.name,
                                        displaySrc || undefined
                                      )
                                    }
                                  >
                                    <FiDownload size={12} aria-hidden />
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-stone-300/70 bg-stone-200/90 px-2.5 py-1 text-[11px] font-medium text-stone-800 dark:border-white/10 dark:bg-slate-700 dark:text-slate-100">
                                <span className="shrink-0 opacity-90">📎</span>
                                <span className="min-w-0 truncate">{file.name}</span>
                                {renderFileDownloadButton(file)}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
              {/** AI：日期/模型居左，复制在日期右侧，悬停显示复制 */}
              <div className="mt-1.5 flex w-full min-w-0 items-center justify-start gap-2 px-1 text-[10px] text-stone-500/85 dark:text-slate-500">
                <div className="min-w-0 shrink-0 text-left">
                  <span className="shrink-0 tabular-nums">{formatMessageTime(message.timestamp)}</span>
                  {message.model && <span className="opacity-80"> · {message.model}</span>}
                </div>
                <div className="opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    onClick={handleCopy}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-stone-200/80 hover:text-primary-500 dark:hover:bg-slate-800"
                    type="button"
                    title={t('message.copyTitle')}
                    aria-label={t('message.copyTitle')}
                  >
                    {copied ? <FiCheck size={13} className="text-emerald-500" /> : <FiCopy size={12} />}
                  </button>
                  {!selectionMode ? (
                    <button
                      onClick={() => onStartSelect?.(message.id)}
                      className="ml-1 inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-stone-200/80 hover:text-primary-500 dark:hover:bg-slate-800"
                      type="button"
                      title={t('message.selectTitle')}
                      aria-label={t('message.selectTitle')}
                    >
                      <FiCheckSquare size={12} />
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      {preview && (
        <ImagePreviewModal
          src={preview.src}
          onClose={() => setPreview(null)}
          alt={t('message.imageAlt')}
          localPath={preview.localPath}
          defaultFileName={preview.defaultFileName}
        />
      )}
    </>
  );
};

export default MessageItem;
