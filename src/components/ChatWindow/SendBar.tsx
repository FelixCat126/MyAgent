import React from 'react';
import { FiSquare } from 'react-icons/fi';

export interface SendBarProps {
  input: string;
  attachments: File[];
  showStop: boolean;
  onSend: () => void;
  onStop: () => void;
  sendLabel: string;
  sendTitle: string;
  stopLabel: string;
  stopTitle: string;
}

/**
 * 发送 / 停止按钮组。
 * 当 showStop 为真时额外渲染停止按钮；发送按钮在输入与附件均为空时禁用。
 */
export const SendBar: React.FC<SendBarProps> = ({
  input,
  attachments,
  showStop,
  onSend,
  onStop,
  sendLabel,
  sendTitle,
  stopLabel,
  stopTitle,
}) => {
  const canSend = input.trim().length > 0 || attachments.length > 0;
  return (
    <>
      {showStop ? (
        <button
          type="button"
          onClick={onStop}
          className="inline-flex h-10 shrink-0 items-center justify-center gap-1 rounded-xl border border-stone-400/50 bg-stone-100 px-4 text-sm font-medium text-stone-800 hover:bg-stone-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
          title={stopTitle}
        >
          <FiSquare size={12} className="shrink-0" />
          {stopLabel}
        </button>
      ) : null}
      <button
        type="button"
        onClick={onSend}
        disabled={!canSend}
        className={`inline-flex h-10 shrink-0 items-center justify-center rounded-xl px-5 text-sm font-medium transition-all ${
          canSend
            ? 'bg-primary-600 text-white shadow-md shadow-primary-500/20 hover:bg-primary-700'
            : 'cursor-not-allowed bg-stone-300 text-stone-500 dark:bg-slate-700 dark:text-slate-500'
        }`}
        title={sendTitle}
      >
        {sendLabel}
      </button>
    </>
  );
};
