import React, { useEffect, useMemo, useState } from 'react';
import { pathToFileURL } from 'url';
import { FileInfo, Message } from '../../types';
import { FiMessageSquare, FiCopy, FiDownload, FiEdit2, FiCheckSquare, FiSquare, FiCheck } from 'react-icons/fi';
import { useI18n } from '../../hooks/useI18n';
import { showError } from '../../store/errorStore';
import MarkdownContent from '../MarkdownContent';
import { markdownContainsPipeTable } from '../../utils/markdownTableDetect';
import { looksLikeStandaloneCodeSnippet } from '../../utils/standaloneCodeDetect';
import { stripGenerateImageArtifactsForDisplay } from '../../utils/toolCalls';
import {
  findConversationGalleryIndex,
  type ConversationImageGalleryItem,
} from '@/utils/conversationImageGallery';
import { attachmentImageDisplaySrc } from '@/utils/attachmentDisplaySrc';
import {
  DownloadLocalFileError,
  downloadDisplayImage,
} from '@/utils/imageDownload';
import {
  MAX_MARKDOWN_RENDER_CHARS,
  MAX_ASSISTANT_PREPROCESS_CHARS,
  MULTI_IMAGE_ATTACHMENT_GRID,
  ASSISTANT_IMAGE_THUMB_IMG,
  ASSISTANT_IMAGE_THUMB_META_ROW,
} from './styleConstants';

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

/** 三个占位组件已抽离到 ./MessageItem/*Placeholder.tsx */
import InlineStreamDots from './InlineStreamDots';
import DocumentGeneratingPlaceholder from './DocumentGeneratingPlaceholder';
import ImageGeneratingPlaceholder from './ImageGeneratingPlaceholder';


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

// AssistantReasoningCollapsible 已抽离到 ./MessageItem/AssistantReasoningCollapsible
// 既要重新导出保留外部 import 兼容，也要让本地 JSX 通过别名可见
import { AssistantReasoningCollapsible as AssistantReasoningCollapsibleImpl } from './AssistantReasoningCollapsible';
import type { AssistantReasoningCollapsibleProps } from './AssistantReasoningCollapsible';
const AssistantReasoningCollapsible = AssistantReasoningCollapsibleImpl;
export { AssistantReasoningCollapsible };
export type { AssistantReasoningCollapsibleProps };

/**
 * 3D 卡片轮播视觉常量：
 * - 左右各显示 3 张邻图（共 7 张同时可见），更厚的"折叠纸牌"层次；
 * - 步长随 abs 衰减（240/130/80），避免侧图溢出舞台外；
 * - 倾斜角度递增（45°/58°/65°），缩放递减（0.78/0.62/0.5），远 z 递增；
 * - 透明度大幅压低（0.4/0.22/0.12），强化"主图无干扰"。
 */

// ImagePreviewModal 已抽离到 ./MessageItem/ImagePreviewModal.tsx
import { ImagePreviewModal } from './ImagePreviewModal';
// 重新导出保留外部 `import { ImagePreviewModal } from './MessageItem'` 兼容
export type { ImagePreviewModalProps } from './ImagePreviewModal';
export { ImagePreviewModal };

// ConversationImageGalleryModal 已抽离到 ./MessageItem/ConversationImageGalleryModal.tsx
// 重新导出保留外部 `import { ConversationImageGalleryModal } from './MessageItem'` 兼容
import { ConversationImageGalleryModal } from './ConversationImageGalleryModal';
export type { ConversationImageGalleryModalProps } from './ConversationImageGalleryModal';
export { ConversationImageGalleryModal };


function formatMessageTime(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const MessageItemBase: React.FC<MessageItemProps> = ({
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
        showError(
          err.code === 'path_empty'
            ? 'message.downloadPathEmpty'
            : 'message.downloadSourceMissing'
        );
        return;
      }
      console.warn('[image-download] failed', fileName);
      showError('message.imageDownloadFailed');
    }
  };

  const renderFileDownloadButton = (file: FileInfo) => {
    if (!file.path) return null;
    const displaySrc = attachmentImageDisplaySrc(file);

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
                    const displaySrc = isImage ? attachmentImageDisplaySrc(file) : '';
                    const canShowImage = isImage && Boolean(displaySrc);

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
                        const displaySrc = isImage ? attachmentImageDisplaySrc(file) : '';
                        const canShowImage = isImage && Boolean(displaySrc);

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

/**
 * memo 化：流式更新最后一条消息时，避免已完成消息重渲染（含 Markdown 重解析）。
 * 自定义比较：只关注影响渲染的关键 props；函数 props（onEdit 等）引用变化不触发重渲染，
 * 因为它们的行为不随消息内容变化。
 */
const MessageItem = React.memo(MessageItemBase, (prev, next) => {
  if (prev.message !== next.message) return false;
  if (prev.editing !== next.editing) return false;
  if (prev.selected !== next.selected) return false;
  if (prev.selectionMode !== next.selectionMode) return false;
  if (prev.conversationStreaming !== next.conversationStreaming) return false;
  if (prev.streamingAssistantId !== next.streamingAssistantId) return false;
  if (prev.showInlineStreamPlaceholder !== next.showInlineStreamPlaceholder) return false;
  if (prev.imageGenProgress !== next.imageGenProgress) return false;
  if (prev.conversationGallery !== next.conversationGallery) return false;
  return true;
});

export default MessageItem;