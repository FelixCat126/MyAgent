import type { VolcAsrDictationConfig } from './types';

/** 与 Chromium Web Speech API / i18n locale 对齐 */
export function speechLangFromUiLocale(locale: string): string {
  if (locale === 'en') return 'en-US';
  return 'zh-CN';
}

type RecognitionCtor = new () => SpeechRecognition;

export function getRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as Window & { webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** 独立于 hook，避免误判「可用栈」不稳定 */
export function hasApiRecordingStack(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof MediaRecorder === 'undefined') return false;
  if (!navigator.mediaDevices?.getUserMedia) return false;
  return typeof window.electron?.transcribeAudio === 'function';
}

/** 火山大模型双向流式 ASR，需主进程挂载 volc-asr-* */
export function hasVolcAsrStack(): boolean {
  if (typeof window === 'undefined') return false;
  if (!navigator.mediaDevices?.getUserMedia) return false;
  const e = window.electron;
  return Boolean(
    e &&
      typeof e.volcAsrStart === 'function' &&
      typeof e.volcAsrPushChunk === 'function' &&
      typeof e.volcAsrFinish === 'function' &&
      typeof e.volcAsrAbort === 'function' &&
      typeof e.onMessage === 'function'
  );
}

export function volcCredsConfigured(c: VolcAsrDictationConfig): boolean {
  return Boolean(c.appKey.trim() && c.accessKey.trim() && c.resourceId.trim());
}
