import React from 'react';
import { FiFile, FiImage, FiLoader, FiMic, FiPaperclip, FiSquare } from 'react-icons/fi';
import ModelSelector from '../ModelSelector';

export interface ChatComposerProps {
  /** 附件 */
  attachments: File[];
  attachmentPreviews: Record<string, string>;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onFileInputClick: () => void;
  onFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemoveAttachment: (index: number) => void;

  /** 输入区 */
  input: string;
  setInput: (v: string) => void;
  inputAreaRef: React.RefObject<HTMLTextAreaElement>;
  onInputKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  isSessionBusy: boolean;
  inputPlaceholder: string;

  /** 麦克风 / 语音唤醒 */
  speechInputEnabled: boolean;
  speechSupported: boolean;
  speechListening: boolean;
  speechStarting: boolean;
  speechBanner: string | null;
  onSpeechToggle: () => void;
  onSpeechClearBanner: () => void;
  voiceWakeListening: boolean;
  voiceWakeStarting: boolean;
  voiceWakePhrase: string;
  setVoiceWakeLoop: (v: boolean) => void;
  voiceStopTitle: string;
  voiceStartingLabel: string;
  voiceInputLabel: string;
  voiceListeningTitle: string;
  speechNotSupportedLabel: string;
  voiceWakeListeningHint: string;
  voiceWakeStartingLabel: string;
  closeLabel: string;

  /** 上下文进度条（数据由调用方注入） */
  stored: number;
  overhead: number;
  softLimit: number;
  fullAt: number;
  truncateRisk: boolean;
  contextUsageHintTemplate: string;
  contextSanitizeWarn: string;

  /** 发送 / 停止 */
  onSend: () => void;
  onStop: () => void;
  showStop: boolean;
  sendLabel: string;
  sendTitle: string;
  stopLabel: string;
  stopTitle: string;
  removeFileLabel: string;
  attachmentsAriaLabel: string;
  uploadFileLabel: string;

  /** 布局 */
  footerH: number;
}

/**
 * 输入区（textarea、附件条、麦克风、模型选择、停止/发送、上下文进度条）。
 * 上下文进度条所需的 store 数据通过 props 传入，子组件只渲染。
 */
export const ChatComposer: React.FC<ChatComposerProps> = (p) => {
  const totalLength = p.stored + p.overhead;
  const fillPerc = Math.min((totalLength / Math.max(1, p.fullAt)) * 100, 100);
  const isNearLimit = fillPerc > 80;
  const softPct = Math.round(Math.min((totalLength / Math.max(1, p.softLimit)) * 100, 100));
  const baseHint = p.contextUsageHintTemplate
    .replace('{used}', String(Math.round(totalLength / 1000)))
    .replace('{limit}', String(Math.round(p.softLimit / 1000)))
    .replace('{pct}', String(softPct));
  const title = p.truncateRisk ? `${baseHint} · ${p.contextSanitizeWarn}` : baseHint;

  const micAriaLabel = p.speechListening
    ? p.voiceStopTitle
    : p.speechStarting
      ? p.voiceStartingLabel
      : p.voiceWakeListening
        ? p.voiceWakeListeningHint
        : p.voiceInputLabel;

  const micTitle = p.speechListening
    ? p.voiceListeningTitle
    : p.speechStarting
      ? p.voiceStartingLabel
      : !p.speechSupported
        ? p.speechNotSupportedLabel
        : p.voiceWakeListening
          ? p.voiceWakeListeningHint
          : p.voiceWakeStarting
            ? p.voiceWakeStartingLabel
            : p.voiceInputLabel;

  return (
    <div
      className="fixed bottom-0 right-0 z-30 flex w-[calc(100%-256px)] min-w-0 flex-col border-t border-stone-600/38 bg-stone-200/92 backdrop-blur-xl dark:border-white/10 dark:bg-[#0B1120]/80"
      style={{ left: 256, paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      {p.attachments.length > 0 && (
        <div
          className="flex shrink-0 flex-wrap justify-start gap-2 border-b border-stone-600/25 bg-transparent px-6 py-1.5 dark:border-white/10"
          aria-label={p.attachmentsAriaLabel}
        >
          {p.attachments.map((file, index) => {
            const preview = p.attachmentPreviews[file.name];
            const isImage = file.type.startsWith('image/');
            const showThumb = isImage && !!preview;
            return (
              <div
                key={`${file.name}-${index}`}
                className="relative flex w-[92px] shrink-0 flex-col items-center gap-1 rounded-lg border border-primary-400/55 bg-transparent px-1 pb-1.5 pt-1 dark:border-primary-500/45"
              >
                <button
                  type="button"
                  onClick={() => p.onRemoveAttachment(index)}
                  className="absolute -right-1 -top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-stone-400/50 bg-stone-100 text-[11px] leading-none text-stone-600 shadow-sm hover:bg-stone-200 dark:border-white/20 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                  title={p.removeFileLabel}
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
      )}

      <div
        className="relative box-border flex min-h-0 w-full min-w-0 flex-col gap-2 px-6 py-1.5 sm:py-2"
        style={{ minHeight: p.footerH }}
      >
        {p.speechInputEnabled && p.speechBanner ? (
          <div className="flex shrink-0 items-center justify-between gap-2 rounded-lg border border-amber-400/35 bg-amber-50/90 px-3 py-1.5 text-xs text-amber-950 dark:border-amber-600/35 dark:bg-amber-950/45 dark:text-amber-50">
            <span className="min-w-0 leading-snug">{p.speechBanner}</span>
            <button
              type="button"
              className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium opacity-80 hover:opacity-100"
              onClick={p.onSpeechClearBanner}
            >
              {p.closeLabel}
            </button>
          </div>
        ) : null}

        {totalLength > 0 ? (
          <div
            className={`absolute top-0 left-0 h-[2px] transition-all duration-300 ${
              isNearLimit || p.truncateRisk ? 'bg-orange-500' : 'bg-gradient-to-r from-primary-400 to-teal-500'
            }`}
            style={{ width: `${fillPerc}%` }}
            title={title}
          />
        ) : null}

        <input
          type="file"
          multiple
          ref={p.fileInputRef}
          onChange={p.onFileInputChange}
          className="hidden"
          accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.xlsm,.md,.markdown,.txt,.csv,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
        />

        <div className="flex min-h-[2.5rem] w-full min-w-0 flex-1 items-center gap-2">
          <div className="flex min-h-10 min-w-0 flex-1 items-center gap-1 rounded-2xl border border-stone-400/28 bg-stone-100/95 py-0 pl-1.5 pr-1 shadow-sm transition-all focus-within:border-primary-500 focus-within:ring-2 focus-within:ring-primary-500/50 dark:border-slate-700 dark:bg-slate-800/80">
            <button
              type="button"
              onClick={p.onFileInputClick}
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-all ${
                p.attachments.length > 0
                  ? 'bg-primary-100/80 text-primary-600 dark:bg-primary-900/30'
                  : 'text-stone-500 hover:bg-stone-300/45 dark:text-slate-500 dark:hover:bg-slate-700'
              }`}
              title={p.uploadFileLabel}
            >
              <FiPaperclip size={14} />
            </button>
            {p.speechInputEnabled ? (
              <button
                type="button"
                aria-pressed={p.speechListening}
                aria-busy={p.speechStarting}
                aria-label={micAriaLabel}
                disabled={p.isSessionBusy || !p.speechSupported || p.speechStarting}
                onClick={() => {
                  if (!p.speechListening) {
                    p.setVoiceWakeLoop(false);
                  }
                  p.onSpeechToggle();
                }}
                title={micTitle}
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-all [&_svg]:pointer-events-none ${
                  p.speechListening
                    ? 'bg-red-600 text-white shadow-sm shadow-red-500/25 animate-pulse'
                    : p.speechStarting
                      ? 'cursor-wait text-primary-600 dark:text-primary-400'
                      : p.isSessionBusy || !p.speechSupported
                        ? 'cursor-not-allowed text-stone-400 dark:text-slate-600'
                        : p.voiceWakeListening
                          ? 'text-primary-600 ring-1 ring-primary-400/60 dark:text-primary-400 dark:ring-primary-500/50'
                          : p.voiceWakeStarting
                            ? 'cursor-wait text-primary-600 dark:text-primary-400'
                            : 'text-stone-600 hover:bg-stone-300/55 dark:text-slate-400 dark:hover:bg-slate-700'
                }`}
              >
                {p.speechStarting || p.voiceWakeStarting ? (
                  <FiLoader size={15} className="animate-spin" aria-hidden />
                ) : (
                  <FiMic size={15} aria-hidden />
                )}
              </button>
            ) : null}
            <textarea
              ref={p.inputAreaRef}
              value={p.input}
              onChange={(e) => p.setInput(e.target.value)}
              onCompositionStart={p.onCompositionStart}
              onCompositionEnd={p.onCompositionEnd}
              onKeyDown={p.onInputKeyDown}
              placeholder={p.inputPlaceholder}
              className="box-border min-h-10 w-full min-w-0 flex-1 resize-none bg-transparent py-2.5 pl-1 pr-0.5 leading-5 text-stone-800 placeholder-stone-500/70 focus:outline-none dark:text-slate-100 text-[clamp(0.8125rem,0.55vw+0.68rem,0.9375rem)]"
              rows={1}
              style={{ maxHeight: 'min(28vh, 9rem)' }}
              disabled={p.isSessionBusy}
            />
            <div className="ml-0.5 flex shrink-0 items-center self-stretch border-l border-stone-400/25 pl-1 dark:border-slate-600">
              <ModelSelector compact />
            </div>
          </div>
          {p.showStop ? (
            <button
              type="button"
              onClick={p.onStop}
              className="inline-flex h-10 shrink-0 items-center justify-center gap-1 rounded-xl border border-stone-400/50 bg-stone-100 px-4 text-sm font-medium text-stone-800 hover:bg-stone-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
              title={p.stopTitle}
            >
              <FiSquare size={12} className="shrink-0" />
              {p.stopLabel}
            </button>
          ) : null}
          <button
            type="button"
            onClick={p.onSend}
            disabled={!p.input.trim() && p.attachments.length === 0}
            className={`inline-flex h-10 shrink-0 items-center justify-center rounded-xl px-5 text-sm font-medium transition-all ${
              p.input.trim() || p.attachments.length > 0
                ? 'bg-primary-600 text-white shadow-md shadow-primary-500/20 hover:bg-primary-700'
                : 'cursor-not-allowed bg-stone-300 text-stone-500 dark:bg-slate-700 dark:text-slate-500'
            }`}
            title={p.sendTitle}
          >
            {p.sendLabel}
          </button>
        </div>
      </div>
    </div>
  );
};