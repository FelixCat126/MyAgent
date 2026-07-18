import React from 'react';
import { FiPaperclip } from 'react-icons/fi';
import ModelSelector from '../ModelSelector';

export interface ComposerInputProps {
  /** 隐藏的文件输入 */
  fileInputRef: React.RefObject<HTMLInputElement>;
  onFileInputClick: () => void;
  onFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;

  /** 输入文本 */
  input: string;
  setInput: (v: string) => void;
  inputAreaRef: React.RefObject<HTMLTextAreaElement>;
  onInputKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  isSessionBusy: boolean;
  inputPlaceholder: string;

  /** 附件数量（仅用于决定回形针按钮的视觉态） */
  attachmentsLength: number;

  /** 上传文件按钮提示 */
  uploadFileLabel: string;

  /**
   * 麦克风按钮插槽。
   * 仅在启用语音输入时由父组件注入 <MicButton />；否则传入 null。
   * 该按钮在结构上位于输入框内部（回形针之后、textarea 之前）。
   */
  micSlot: React.ReactNode;
}

/**
 * 输入区：包含隐藏的 file input、回形针按钮、（可选）麦克风按钮、
 * textarea 以及 ModelSelector。麦克风按钮通过 micSlot 注入。
 * 返回片段结构：隐藏的 file input + 输入框 div。
 * 调用方需将这些片段连同 SendBar 一起置于外层 flex 行中
 * （与原结构保持一致：file input 在行外，输入框与按钮在同一 flex 行）。
 */
export const ComposerInput: React.FC<ComposerInputProps> = ({
  fileInputRef,
  onFileInputClick,
  onFileInputChange,
  input,
  setInput,
  inputAreaRef,
  onInputKeyDown,
  onCompositionStart,
  onCompositionEnd,
  isSessionBusy,
  inputPlaceholder,
  attachmentsLength,
  uploadFileLabel,
  micSlot,
}) => {
  return (
    <>
      <input
        type="file"
        multiple
        ref={fileInputRef}
        onChange={onFileInputChange}
        className="hidden"
        accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.xlsm,.md,.markdown,.txt,.csv,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
      />

      <div className="flex min-h-10 min-w-0 flex-1 items-center gap-1 rounded-2xl border border-stone-400/28 bg-stone-100/95 py-0 pl-1.5 pr-1 shadow-sm transition-all focus-within:border-primary-500 focus-within:ring-2 focus-within:ring-primary-500/50 dark:border-slate-700 dark:bg-slate-800/80">
        <button
          type="button"
          onClick={onFileInputClick}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-all ${
            attachmentsLength > 0
              ? 'bg-primary-100/80 text-primary-600 dark:bg-primary-900/30'
              : 'text-stone-500 hover:bg-stone-300/45 dark:text-slate-500 dark:hover:bg-slate-700'
          }`}
          title={uploadFileLabel}
        >
          <FiPaperclip size={14} />
        </button>
        {micSlot}
        <textarea
          ref={inputAreaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          onKeyDown={onInputKeyDown}
          placeholder={inputPlaceholder}
          className="box-border min-h-10 w-full min-w-0 flex-1 resize-none bg-transparent py-2.5 pl-1 pr-0.5 leading-5 text-stone-800 placeholder-stone-500/70 focus:outline-none dark:text-slate-100 text-[clamp(0.8125rem,0.55vw+0.68rem,0.9375rem)]"
          rows={1}
          style={{ maxHeight: 'min(28vh, 9rem)' }}
          disabled={isSessionBusy}
        />
        <div className="ml-0.5 flex shrink-0 items-center self-stretch border-l border-stone-400/25 pl-1 dark:border-slate-600">
          <ModelSelector compact />
        </div>
      </div>
    </>
  );
};
