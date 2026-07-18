import type { ModelConfig } from '@/types';

export type VolcAsrDictationConfig = {
  appKey: string;
  accessKey: string;
  resourceId: string;
};

export type SpeechApiTranscribeConfig = Pick<ModelConfig, 'apiUrl' | 'apiKey' | 'provider'>;

export type SpeechDictationLabels = {
  notSupported: string;
  needMic: string;
  startFailed: string;
  networkOrService: string;
  noSpeech: string;
  genericError: string;
  transcribeFailed: string;
  transcribeDenied: string;
};

export type SpeechDictationStartOptions = {
  /** 由语音唤醒触发的听写，结束时自动发送 */
  fromWake?: boolean;
};

export type SpeechDictationEndedDetail = {
  autoSend: boolean;
  /** 听写结束时的完整输入框文本 */
  transcript: string;
};

/** 'volc'：火山流式；'api'：单次转写；'web'：Web Speech */
export type DictationKind = 'none' | 'web' | 'api' | 'volc';

export type SpeechDictationOptions = {
  inputValueRef: React.MutableRefObject<string>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  setInput: (next: string) => void;
  uiLocale: string;
  disabled?: boolean;
  isImeComposing?: () => boolean;
  labels: SpeechDictationLabels;
  /** 火山流式 ASR（配置齐备时优先于 API 单次转写与 Web Speech） */
  getVolcAsrConfig?: () => VolcAsrDictationConfig | null;
  /** 若有 OpenAI 兼容 Key，则优先走录音 + /audio/transcriptions，避免内置语音走 Google */
  getApiTranscribeConfig?: () => SpeechApiTranscribeConfig | null;
  /** 听写自然结束（非 abort）时回调；fromWake 时为 autoSend */
  onDictationEnded?: (detail: SpeechDictationEndedDetail) => void;
};
