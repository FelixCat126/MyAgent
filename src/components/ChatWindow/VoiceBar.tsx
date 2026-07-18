import React from 'react';
import { FiLoader, FiMic } from 'react-icons/fi';

export interface VoiceBannerProps {
  speechInputEnabled: boolean;
  speechBanner: string | null;
  onSpeechClearBanner: () => void;
  closeLabel: string;
}

/**
 * 语音状态横幅（顶部琥珀色提示条）。
 * 当未启用语音输入或没有 banner 文本时返回 null。
 */
export const VoiceBanner: React.FC<VoiceBannerProps> = ({
  speechInputEnabled,
  speechBanner,
  onSpeechClearBanner,
  closeLabel,
}) => {
  if (!speechInputEnabled || !speechBanner) return null;
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 rounded-lg border border-amber-400/35 bg-amber-50/90 px-3 py-1.5 text-xs text-amber-950 dark:border-amber-600/35 dark:bg-amber-950/45 dark:text-amber-50">
      <span className="min-w-0 leading-snug">{speechBanner}</span>
      <button
        type="button"
        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium opacity-80 hover:opacity-100"
        onClick={onSpeechClearBanner}
      >
        {closeLabel}
      </button>
    </div>
  );
};

export interface MicButtonProps {
  speechListening: boolean;
  speechStarting: boolean;
  speechSupported: boolean;
  isSessionBusy: boolean;
  voiceWakeListening: boolean;
  voiceWakeStarting: boolean;
  onSpeechToggle: () => void;
  setVoiceWakeLoop: (v: boolean) => void;
  micAriaLabel: string;
  micTitle: string;
}

/**
 * 麦克风按钮（语音输入 / 唤醒词切换）。
 * 该按钮在结构上位于输入框内部，因此作为独立单元导出，
 * 由 ComposerInput 通过 children/slot 方式嵌入。
 */
export const MicButton: React.FC<MicButtonProps> = ({
  speechListening,
  speechStarting,
  speechSupported,
  isSessionBusy,
  voiceWakeListening,
  voiceWakeStarting,
  onSpeechToggle,
  setVoiceWakeLoop,
  micAriaLabel,
  micTitle,
}) => {
  return (
    <button
      type="button"
      aria-pressed={speechListening}
      aria-busy={speechStarting}
      aria-label={micAriaLabel}
      disabled={isSessionBusy || !speechSupported || speechStarting}
      onClick={() => {
        if (!speechListening) {
          setVoiceWakeLoop(false);
        }
        onSpeechToggle();
      }}
      title={micTitle}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-all [&_svg]:pointer-events-none ${
        speechListening
          ? 'bg-red-600 text-white shadow-sm shadow-red-500/25 animate-pulse'
          : speechStarting
            ? 'cursor-wait text-primary-600 dark:text-primary-400'
            : isSessionBusy || !speechSupported
              ? 'cursor-not-allowed text-stone-400 dark:text-slate-600'
              : voiceWakeListening
                ? 'text-primary-600 ring-1 ring-primary-400/60 dark:text-primary-400 dark:ring-primary-500/50'
                : voiceWakeStarting
                  ? 'cursor-wait text-primary-600 dark:text-primary-400'
                  : 'text-stone-600 hover:bg-stone-300/55 dark:text-slate-400 dark:hover:bg-slate-700'
      }`}
    >
      {speechStarting || voiceWakeStarting ? (
        <FiLoader size={15} className="animate-spin" aria-hidden />
      ) : (
        <FiMic size={15} aria-hidden />
      )}
    </button>
  );
};
