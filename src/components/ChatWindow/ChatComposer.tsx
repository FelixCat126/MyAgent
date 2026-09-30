import React from 'react';
import { AttachmentStrip } from './AttachmentStrip';
import { ComposerInput } from './ComposerInput';
import { ContextMeter } from './ContextMeter';
import { MicButton, VoiceBanner } from './VoiceBar';
import { SendBar } from './SendBar';
import { SIDEBAR_W_PX } from '../../constants/layout';

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
  showScrollToLatest: boolean;
  onScrollToLatest: () => void;
  scrollToLatestLabel: string;
}

/**
 * 输入区装配组件（textarea、附件条、麦克风、模型选择、停止/发送、上下文进度条）。
 * 仅负责装配 5 个按域拆分的子组件，不直接渲染业务 JSX。
 * 上下文进度条所需的 store 数据通过 props 传入，子组件只渲染。
 */
export const ChatComposer: React.FC<ChatComposerProps> = (p) => {
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

  const micSlot = p.speechInputEnabled ? (
    <MicButton
      speechListening={p.speechListening}
      speechStarting={p.speechStarting}
      speechSupported={p.speechSupported}
      isSessionBusy={p.isSessionBusy}
      voiceWakeListening={p.voiceWakeListening}
      voiceWakeStarting={p.voiceWakeStarting}
      onSpeechToggle={p.onSpeechToggle}
      setVoiceWakeLoop={p.setVoiceWakeLoop}
      micAriaLabel={micAriaLabel}
      micTitle={micTitle}
    />
  ) : null;

  return (
    <div
      className="fixed bottom-0 right-0 z-30 flex w-[calc(100%-256px)] min-w-0 flex-col border-t border-stone-600/38 bg-stone-200/92 backdrop-blur-xl dark:border-white/10 dark:bg-darkChrome/80"
      style={{ left: SIDEBAR_W_PX, paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      {p.showScrollToLatest ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex -translate-y-[calc(100%+10px)] justify-center">
          <button
            type="button"
            className="pointer-events-auto inline-flex h-10 w-10 items-center justify-center rounded-full border border-stone-300/80 bg-white/95 text-stone-600 shadow-[0_8px_24px_rgba(15,23,42,0.18)] backdrop-blur-md transition-[transform,background-color,color,border-color] duration-150 hover:-translate-y-0.5 hover:border-primary-400 hover:text-primary-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/65 dark:border-white/15 dark:bg-slate-800/95 dark:text-slate-200 dark:hover:border-primary-400/70 dark:hover:bg-slate-700 dark:hover:text-primary-200"
            onClick={p.onScrollToLatest}
            title={p.scrollToLatestLabel}
            aria-label={p.scrollToLatestLabel}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-[18px] w-[18px]"
              aria-hidden="true"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </div>
      ) : null}

      <AttachmentStrip
        attachments={p.attachments}
        attachmentPreviews={p.attachmentPreviews}
        onRemoveAttachment={p.onRemoveAttachment}
        removeFileLabel={p.removeFileLabel}
        attachmentsAriaLabel={p.attachmentsAriaLabel}
      />

      <div
        className="relative box-border flex min-h-0 w-full min-w-0 flex-col gap-2 px-6 py-1.5 sm:py-2"
        style={{ minHeight: p.footerH }}
      >
        <VoiceBanner
          speechInputEnabled={p.speechInputEnabled}
          speechBanner={p.speechBanner}
          onSpeechClearBanner={p.onSpeechClearBanner}
          closeLabel={p.closeLabel}
        />

        <ContextMeter
          stored={p.stored}
          overhead={p.overhead}
          softLimit={p.softLimit}
          fullAt={p.fullAt}
          truncateRisk={p.truncateRisk}
          contextUsageHintTemplate={p.contextUsageHintTemplate}
          contextSanitizeWarn={p.contextSanitizeWarn}
        />

        <div className="flex min-h-[2.5rem] w-full min-w-0 flex-1 items-center gap-2">
          <ComposerInput
            fileInputRef={p.fileInputRef}
            onFileInputClick={p.onFileInputClick}
            onFileInputChange={p.onFileInputChange}
            input={p.input}
            setInput={p.setInput}
            inputAreaRef={p.inputAreaRef}
            onInputKeyDown={p.onInputKeyDown}
            onCompositionStart={p.onCompositionStart}
            onCompositionEnd={p.onCompositionEnd}
            isSessionBusy={p.isSessionBusy}
            inputPlaceholder={p.inputPlaceholder}
            attachmentsLength={p.attachments.length}
            uploadFileLabel={p.uploadFileLabel}
            micSlot={micSlot}
          />
          <SendBar
            input={p.input}
            attachments={p.attachments}
            showStop={p.showStop}
            onSend={p.onSend}
            onStop={p.onStop}
            sendLabel={p.sendLabel}
            sendTitle={p.sendTitle}
            stopLabel={p.stopLabel}
            stopTitle={p.stopTitle}
          />
        </div>
      </div>
    </div>
  );
};
