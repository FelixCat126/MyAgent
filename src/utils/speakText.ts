import { pickSpeakVoice, speechLangFromUiLocale, waitForVoices } from './speechVoice';

export type SpeakTextOptions = {
  /** 播完后的尾静音（ms）；唤醒场景可设为 0 以尽快开麦 */
  tailSilenceMs?: number;
};

/**
 * 使用浏览器 SpeechSynthesis 朗读短句（唤醒确认等）。
 * 选音顺序：Lilian → Yue → 系统默认。
 * 播完后默认额外等待 ~180ms 再 resolve，降低麦克风误录扬声器回声的概率。
 */
export async function speakText(
  text: string,
  locale: string,
  opts?: SpeakTextOptions,
): Promise<void> {
  const tailSilenceMs = opts?.tailSilenceMs ?? 180;
  const trimmed = text.trim();
  if (!trimmed) return;

  const syn = typeof window !== 'undefined' ? window.speechSynthesis : null;
  if (!syn) return;

  syn.cancel();

  const lang = speechLangFromUiLocale(locale);
  const voices = await waitForVoices(syn);
  const pick = pickSpeakVoice(voices, lang);
  if (!pick) return;

  await new Promise<void>((resolve) => {
    const utter = new SpeechSynthesisUtterance(trimmed);
    utter.lang = lang;
    if (pick.voice) utter.voice = pick.voice;
    utter.rate = 0.96;
    utter.pitch = 1;
    const finish = () => {
      if (tailSilenceMs <= 0) resolve();
      else window.setTimeout(resolve, tailSilenceMs);
    };
    utter.onend = finish;
    utter.onerror = finish;
    syn.speak(utter);
  });
}
