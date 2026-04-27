import React, { useState } from 'react';
import { pathToFileURL } from 'url';
import { Message } from '../types';
import { FiMessageSquare, FiRefreshCw, FiCopy } from 'react-icons/fi';
import { useI18n } from '../hooks/useI18n';

interface MessageItemProps {
  message: Message;
  onResend?: (message: Message) => void;
}

export const ImagePreviewModal: React.FC<{ src: string; onClose: () => void; alt: string }> = ({ src, onClose, alt }) => {
  const { t } = useI18n();
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 backdrop-blur-sm transition-opacity"
      onClick={onClose}
    >
      <div className="relative max-w-[90vw] max-h-[85vh] flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={onClose}
          className="absolute -top-10 right-0 text-white hover:text-primary-400 transition-colors text-xl"
          title={t('message.closePreview')}
        >
          ×
        </button>
        <img src={src} alt={alt} className="max-h-[85vh] max-w-[90vw] object-contain shadow-2xl rounded-lg" />
      </div>
    </div>
  );
};

function formatMessageTime(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const MessageItem: React.FC<MessageItemProps> = ({ message, onResend }) => {
  const { t } = useI18n();
  const isUser = message.role === 'user';
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
    } catch {}
  };

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
                                  onClick={() => displaySrc && setPreviewSrc(displaySrc)}
                                  className="max-h-[180px] max-w-[240px] cursor-zoom-in rounded-md object-contain shadow-sm transition-transform hover:scale-[1.02] border border-white/50 ring-1 ring-white/25"
                                />
                                <span className="max-w-[240px] truncate text-[11px] font-medium text-white/95">
                                  {file.name}
                                </span>
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
                                onClick={() => displaySrc && setPreviewSrc(displaySrc)}
                                className="max-h-[180px] max-w-[240px] cursor-zoom-in rounded-md object-contain border border-stone-300/60 shadow-sm transition-transform hover:scale-[1.02] dark:border-white/10"
                              />
                              <span className="max-w-[240px] truncate text-[11px] font-medium text-stone-700 dark:text-slate-300">
                                {file.name}
                              </span>
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
                )}
                <div className="whitespace-pre-wrap text-sm break-words">{message.content}</div>
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
      {previewSrc && (
        <ImagePreviewModal src={previewSrc} onClose={() => setPreviewSrc(null)} alt={t('message.imageAlt')} />
      )}
    </>
  );
};

export default MessageItem;