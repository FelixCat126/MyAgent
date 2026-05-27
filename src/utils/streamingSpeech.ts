import { stripMarkdownForSpeech, takeCompleteSentences } from './stripMarkdownForSpeech';
import {
  pickSpeakVoice,
  speechLangFromUiLocale,
  type SpeakVoicePick,
  waitForVoices,
} from './speechVoice';

type VoicePick = { lang: string } & SpeakVoicePick;

async function loadVoicePick(locale: string): Promise<VoicePick | null> {
  const syn = typeof window !== 'undefined' ? window.speechSynthesis : null;
  if (!syn) return null;
  const lang = speechLangFromUiLocale(locale);
  const voices = await waitForVoices(syn);
  const pick = pickSpeakVoice(voices, lang);
  if (!pick) return null;
  return { lang, ...pick };
}

function speakOne(text: string, pick: VoicePick): Promise<void> {
  const syn = window.speechSynthesis;
  return new Promise((resolve) => {
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = pick.lang;
    if (pick.voice) utter.voice = pick.voice;
    utter.rate = 0.96;
    utter.pitch = 1;
    const finish = () => resolve();
    utter.onend = finish;
    utter.onerror = finish;
    syn.speak(utter);
  });
}

export type StreamingSpeechOptions = {
  onSpeakingChange?: (speaking: boolean) => void;
};

/** 流式回复分段播报：只读正文 delta，不读思考过程 */
export class StreamingSpeechReader {
  private rawBuffer = '';
  private spokenPlainIndex = 0;
  private queue: string[] = [];
  private draining = false;
  private cancelled = false;
  private finished = false;
  private pick: VoicePick | null = null;

  constructor(
    private readonly locale: string,
    private readonly opts: StreamingSpeechOptions = {},
  ) {}

  async start(): Promise<void> {
    this.cancelled = false;
    this.finished = false;
    this.rawBuffer = '';
    this.spokenPlainIndex = 0;
    this.pick = await loadVoicePick(this.locale);
  }

  push(delta: string): void {
    if (this.cancelled || !delta) return;
    this.rawBuffer += delta;
    const plain = stripMarkdownForSpeech(this.rawBuffer);
    const unspoken = plain.slice(this.spokenPlainIndex);
    if (!unspoken) return;
    const { sentences, remainder } = takeCompleteSentences(unspoken);
    this.spokenPlainIndex += unspoken.length - remainder.length;
    for (const s of sentences) this.queue.push(s);
    void this.drainQueue();
  }

  finish(): void {
    if (this.cancelled || this.finished) return;
    this.finished = true;
    const plain = stripMarkdownForSpeech(this.rawBuffer);
    const tail = plain.slice(this.spokenPlainIndex).trim();
    if (tail.length >= 1) {
      this.queue.push(tail);
      this.spokenPlainIndex = plain.length;
    }
    void this.drainQueue(true);
  }

  cancel(): void {
    this.cancelled = true;
    this.queue = [];
    this.draining = false;
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* ignore */
    }
    this.opts.onSpeakingChange?.(false);
  }

  private async drainQueue(isFinal = false): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    if (this.queue.length > 0) this.opts.onSpeakingChange?.(true);

    while (this.queue.length > 0 && !this.cancelled) {
      const seg = this.queue.shift();
      if (!seg?.trim()) continue;
      const pick = this.pick ?? (await loadVoicePick(this.locale));
      if (!pick || this.cancelled) break;
      this.pick = pick;
      await speakOne(seg.trim(), pick);
    }

    this.draining = false;
    if (this.cancelled) {
      this.opts.onSpeakingChange?.(false);
      return;
    }
    if (this.queue.length > 0) {
      void this.drainQueue(isFinal);
      return;
    }
    if (isFinal || this.finished) {
      this.opts.onSpeakingChange?.(false);
    }
  }
}
