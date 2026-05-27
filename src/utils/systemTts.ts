import { pickSpeakVoice, speechLangFromUiLocale, waitForVoices } from './speechVoice';

let cached: boolean | null = null;
let pending: Promise<boolean> | null = null;

/** 检测本机是否具备可用语音播报（Lilian / Yue / 系统默认 至少其一） */
export async function detectSystemTtsAvailable(uiLocale: string): Promise<boolean> {
  if (cached !== null) return cached;
  if (pending) return pending;

  pending = (async () => {
    if (typeof window === 'undefined') {
      cached = false;
      return false;
    }
    const syn = window.speechSynthesis;
    if (!syn || typeof SpeechSynthesisUtterance === 'undefined') {
      cached = false;
      return false;
    }
    try {
      const voices = await waitForVoices(syn);
      const lang = speechLangFromUiLocale(uiLocale);
      const ok = pickSpeakVoice(voices, lang) !== null;
      cached = ok;
      return ok;
    } catch {
      cached = false;
      return false;
    } finally {
      pending = null;
    }
  })();

  return pending;
}

export function getSystemTtsAvailableCached(): boolean | null {
  return cached;
}
