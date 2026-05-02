import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pathToFileURL } from 'url';
import { Message } from '../types';
import { FiMessageSquare, FiRefreshCw, FiCopy, FiDownload, FiChevronDown, FiChevronRight, FiChevronLeft, FiX } from 'react-icons/fi';
import { useI18n } from '../hooks/useI18n';
import MarkdownContent from './MarkdownContent';
import { markdownContainsPipeTable } from '../utils/markdownTableDetect';
import { looksLikeStandaloneCodeSnippet } from '../utils/standaloneCodeDetect';
import { stripGenerateImageArtifactsForDisplay } from '../utils/toolCalls';
import {
  findConversationGalleryIndex,
  type ConversationImageGalleryItem,
} from '@/utils/conversationImageGallery';

const MAX_MARKDOWN_RENDER_CHARS = 24_000;
const MAX_ASSISTANT_PREPROCESS_CHARS = 28_000;

/** 对应 App.tsx 顶栏拖拽区 TITLEBAR_H(44)，避免按钮落在 Electron drag 带上被吞点击 */
const MODAL_CLEAR_TITLEBAR_PT = 'pt-[52px]';

const MODAL_PORTAL_LAYER_CLASS = 'fixed inset-0 z-[10010] flex items-center justify-center bg-black/70 backdrop-blur-sm transition-opacity';

const modalPortalShellStyle: React.CSSProperties & { WebkitAppRegion?: string } = {
  WebkitAppRegion: 'no-drag',
};

interface MessageItemProps {
  message: Message;
  onResend?: (message: Message) => void;
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

function AssistantReasoningCollapsible(props: {
  reasoning: string;
  isThoughtStreaming: boolean;
  t: (key: string) => string;
}) {
  const { reasoning, isThoughtStreaming, t } = props;
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isThoughtStreaming) setExpanded(false);
  }, [isThoughtStreaming]);

  const showBody = isThoughtStreaming || expanded;

  const handleToggle = () => {
    if (isThoughtStreaming) return;
    setExpanded((v) => !v);
  };

  useLayoutEffect(() => {
    if (!showBody) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
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
  /** 本机磁盘路径，用于「另存为」拷贝（无则隐藏下载按钮） */
  localPath?: string;
  defaultFileName?: string;
}> = ({ src, onClose, alt, localPath, defaultFileName }) => {
  const { t } = useI18n();
  const canDownload = Boolean(localPath);

  const handleSaveCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!localPath) return;
    await window.electron.saveLocalFileCopy({
      sourcePath: localPath,
      defaultFileName: defaultFileName || 'image.png',
    });
  };

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
          {canDownload ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md bg-white/10 px-2.5 py-1 text-sm text-white backdrop-blur-sm transition-colors hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/55"
              title={t('message.imagePreviewDownload')}
              onClick={(e) => void handleSaveCopy(e)}
            >
              <FiDownload size={14} aria-hidden />
              <span>{t('message.imagePreviewDownload')}</span>
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
        <img
          src={src}
          alt={alt}
          className="relative z-0 mx-auto block max-h-[min(calc(85vh-120px),80vh)] max-w-full object-contain rounded-lg shadow-2xl"
        />
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(node, document.body) : null;
};

export const ConversationImageGalleryModal: React.FC<{
  slides: ConversationImageGalleryItem[];
  startIndex: number;
  onClose: () => void;
}> = ({ slides, startIndex, onClose }) => {
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

  const handleSaveCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await window.electron.saveLocalFileCopy({
      sourcePath: slide.localPath,
      defaultFileName: slide.defaultFileName || 'image.png',
    });
  };

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
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md bg-white/10 px-2.5 py-1 text-sm text-white backdrop-blur-sm transition-colors hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/55"
            title={t('message.imagePreviewDownload')}
            onClick={(e) => void handleSaveCopy(e)}
          >
            <FiDownload size={14} aria-hidden />
            <span>{t('message.imagePreviewDownload')}</span>
          </button>
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
              className="max-h-[min(72vh,880px)] max-w-full object-contain rounded-lg shadow-2xl"
            />
            <p className="text-center text-sm text-white/90 tabular-nums">
              {t('message.imageGalleryPosition', { current: idx + 1, total: slides.length })}
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
  onResend,
  conversationStreaming = false,
  streamingAssistantId = null,
  showInlineStreamPlaceholder = false,
  conversationGallery,
  onOpenConversationGallery,
}) => {
  const { t } = useI18n();
  const isUser = message.role === 'user';
  const [preview, setPreview] = useState<{
    src: string;
    localPath?: string;
    defaultFileName?: string;
  } | null>(null);

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

  const downloadAttachmentCopy = async (e: React.MouseEvent, localPath: string, fileName: string) => {
    e.preventDefault();
    e.stopPropagation();
    await window.electron.saveLocalFileCopy({
      sourcePath: localPath,
      defaultFileName: fileName,
    });
  };

  const isThoughtStreaming =
    message.role === 'assistant' &&
    conversationStreaming &&
    !!streamingAssistantId &&
    message.id === streamingAssistantId;

  const assistantDisplayBody = useMemo(
    () => {
      if (message.role !== 'assistant') return '';
      const raw = message.content ?? '';
      const capped =
        raw.length > MAX_ASSISTANT_PREPROCESS_CHARS
          ? `${raw.slice(0, MAX_ASSISTANT_PREPROCESS_CHARS)}\n\n[内容过长，已截断显示；复制按钮仍会复制完整内容]`
          : raw;
      return stripGenerateImageArtifactsForDisplay(capped);
    },
    [message.role, message.content]
  );

  const handleCopy = async () => {
    try {
      const text =
        message.role === 'user'
          ? (message.content ?? '')
          : stripGenerateImageArtifactsForDisplay(message.content ?? '');
      await navigator.clipboard.writeText(text);
    } catch {}
  };

  const handleSaveExport = async (format: 'md' | 'xlsx' | 'docx') => {
    const raw = message.role === 'assistant' ? assistantDisplayBody : (message.content ?? '');
    const safe = String(raw).slice(0, 40).replace(/[\\/:"*?<>|\r\n]/g, '_');
    const base = safe || `reply-${message.timestamp}`;
    await window.electron.saveAssistantExport({
      format,
      content: raw,
      defaultBaseName: base,
    });
  };

  const standaloneCode =
    message.role !== 'user' &&
    !(message.files && message.files.length > 0) &&
    looksLikeStandaloneCodeSnippet(assistantDisplayBody);
  const markdownBody =
    assistantDisplayBody.length > MAX_MARKDOWN_RENDER_CHARS
      ? `${assistantDisplayBody.slice(0, MAX_MARKDOWN_RENDER_CHARS)}\n\n[内容过长，已截断显示；复制按钮仍会复制完整内容]`
      : assistantDisplayBody;

  /** 以上为助手展示/导出正文（已剔除生图工具 JSON） */

  return (
    <>
      <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} group mb-4`}>
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
                    <div className="mb-2 flex flex-wrap gap-2">
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
                            className="relative group/file max-w-full transition-all"
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
                                  className="max-h-[180px] max-w-[240px] cursor-zoom-in rounded-md object-contain shadow-sm transition-transform hover:scale-[1.02] border border-white/50 ring-1 ring-white/25"
                                />
                                <div className="flex max-w-[240px] items-center gap-1">
                                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-white/95">
                                    {file.name}
                                  </span>
                                  <button
                                    type="button"
                                    className="shrink-0 rounded p-0.5 text-white/90 hover:bg-white/15"
                                    title={t('message.imagePreviewDownload')}
                                    aria-label={t('message.imagePreviewDownload')}
                                    onClick={(e) => void downloadAttachmentCopy(e, file.path, file.name)}
                                  >
                                    <FiDownload size={12} aria-hidden />
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className="inline-flex max-w-full items-center gap-1 rounded-md border border-white/40 bg-white/20 px-2.5 py-1 text-[11px] font-medium text-white shadow-sm">
                                <span className="shrink-0 opacity-90">📎</span>
                                <span className="min-w-0 truncate">{file.name}</span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div className="whitespace-pre-wrap text-sm break-words">{message.content}</div>
                </div>
                {/** 与气泡同宽；日期最右，复制/重发在左、悬停显示 */}
                <div className="mt-1.5 flex w-full min-w-0 items-center justify-end gap-2 text-[10px] text-stone-500/85 dark:text-slate-500">
                  <div className="flex min-w-0 items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      onClick={handleCopy}
                      className="inline-flex shrink-0 items-center gap-0.5 hover:text-primary-500"
                      type="button"
                      title={t('message.copyTitle')}
                    >
                      <FiCopy size={10} />
                      <span>{t('message.copy')}</span>
                    </button>
                    {onResend && (
                      <button
                        onClick={() => onResend(message)}
                        className="inline-flex shrink-0 items-center gap-0.5 hover:text-primary-500"
                        type="button"
                        title={t('message.resendTitle')}
                      >
                        <FiRefreshCw size={10} />
                        <span>{t('message.resend')}</span>
                      </button>
                    )}
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
                {(isThoughtStreaming || (message.reasoning ?? '').trim().length > 0) && (
                  <AssistantReasoningCollapsible
                    reasoning={message.reasoning ?? ''}
                    isThoughtStreaming={isThoughtStreaming}
                    t={t}
                  />
                )}
                {showInlineStreamPlaceholder ? (
                  <div className="pt-0.5">
                    <InlineStreamDots />
                  </div>
                ) : null}
                {standaloneCode ? (
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
                ) : showInlineStreamPlaceholder ? null : (
                  <MarkdownContent text={markdownBody} copyCodeLabel={t('message.copyCodeBlock')} />
                )}
                {!standaloneCode &&
                markdownBody.trim() &&
                markdownContainsPipeTable(markdownBody) ? (
                  <div className="mt-3 flex flex-wrap gap-1.5 border-t border-stone-200/80 pt-2.5 dark:border-slate-600/50">
                    <p className="mb-0.5 text-[10px] leading-snug text-stone-500 dark:text-slate-400">
                      {t('chat.exportStripHint')}
                    </p>
                    <button
                      type="button"
                      onClick={() => void handleSaveExport('md')}
                      className="inline-flex items-center gap-1 rounded-md border border-stone-300/60 bg-white/60 px-2 py-1 text-[10px] font-medium text-stone-600 hover:bg-stone-100 dark:border-slate-600 dark:bg-slate-700/50 dark:text-slate-200 dark:hover:bg-slate-600"
                    >
                      <FiDownload size={11} />
                      {t('chat.downloadMd')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleSaveExport('xlsx')}
                      className="inline-flex items-center gap-1 rounded-md border border-stone-300/60 bg-white/60 px-2 py-1 text-[10px] font-medium text-stone-600 hover:bg-stone-100 dark:border-slate-600 dark:bg-slate-700/50 dark:text-slate-200 dark:hover:bg-slate-600"
                    >
                      <FiDownload size={11} />
                      {t('chat.downloadXlsx')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleSaveExport('docx')}
                      className="inline-flex items-center gap-1 rounded-md border border-stone-300/60 bg-white/60 px-2 py-1 text-[10px] font-medium text-stone-600 hover:bg-stone-100 dark:border-slate-600 dark:bg-slate-700/50 dark:text-slate-200 dark:hover:bg-slate-600"
                    >
                      <FiDownload size={11} />
                      {t('chat.downloadDocx')}
                    </button>
                  </div>
                ) : null}
                {message.files && message.files.length > 0 && (
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
                    <div className="flex flex-wrap gap-2">
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
                            className="relative group/file max-w-full transition-all"
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
                                  className="max-h-[180px] max-w-[240px] cursor-zoom-in rounded-md object-contain border border-stone-300/60 shadow-sm transition-transform hover:scale-[1.02] dark:border-white/10"
                                />
                                <div className="flex max-w-[240px] items-center gap-1">
                                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-stone-700 dark:text-slate-300">
                                    {file.name}
                                  </span>
                                  <button
                                    type="button"
                                    className="shrink-0 rounded p-0.5 text-stone-600 hover:bg-stone-200 dark:text-slate-300 dark:hover:bg-slate-600"
                                    title={t('message.imagePreviewDownload')}
                                    aria-label={t('message.imagePreviewDownload')}
                                    onClick={(e) => void downloadAttachmentCopy(e, file.path, file.name)}
                                  >
                                    <FiDownload size={12} aria-hidden />
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className="inline-flex max-w-full items-center gap-1 rounded-md border border-stone-300/70 bg-stone-200/90 px-2.5 py-1 text-[11px] font-medium text-stone-800 dark:border-white/10 dark:bg-slate-700 dark:text-slate-100">
                                <span className="shrink-0 opacity-90">📎</span>
                                <span className="min-w-0 truncate">{file.name}</span>
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
                    className="inline-flex items-center gap-0.5 hover:text-primary-500"
                    type="button"
                    title={t('message.copyTitle')}
                  >
                    <FiCopy size={10} />
                    <span>{t('message.copy')}</span>
                  </button>
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
