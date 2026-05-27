/** 与语音识别 locale 对齐 */
export function speechLangFromUiLocale(locale: string): string {
  if (locale === 'en') return 'en-US';
  return 'zh-CN';
}

export type SpeakVoicePick = {
  /** null 表示使用系统默认语音（不显式设置 utter.voice） */
  voice: SpeechSynthesisVoice | null;
  source: 'lilian' | 'yue' | 'default';
};

const QUALITY_SCORES: Array<{ pattern: RegExp; score: number }> = [
  { pattern: /premium/i, score: 100 },
  { pattern: /enhanced|增强/i, score: 95 },
  { pattern: /eloquence/i, score: 90 },
  { pattern: /neural|自然/i, score: 85 },
  { pattern: /compact/i, score: -90 },
  { pattern: /low.?quality|低质量/i, score: -40 },
];

function voiceLabel(voice: SpeechSynthesisVoice): string {
  return `${voice.name} ${voice.voiceURI}`.toLowerCase();
}

function isLilianVoice(voice: SpeechSynthesisVoice): boolean {
  const label = voiceLabel(voice);
  return /\blilian\b/.test(label) || /莉莲/.test(voice.name);
}

function isYueVoice(voice: SpeechSynthesisVoice): boolean {
  const label = voiceLabel(voice);
  return /\byue\b/.test(label) || /悦/.test(voice.name);
}

function isPremiumLikeVoice(voice: SpeechSynthesisVoice): boolean {
  return /premium|enhanced|增强|eloquence|neural/i.test(voiceLabel(voice));
}

function scoreVoice(voice: SpeechSynthesisVoice, lang: string): number {
  const voiceLang = voice.lang.replace('_', '-').toLowerCase();
  const langPrefix = lang.split('-')[0].toLowerCase();

  let score = 0;
  if (voiceLang.startsWith(langPrefix)) score += 15;
  if (voiceLang === lang.toLowerCase()) score += 25;
  if (voice.localService) score += 8;

  for (const { pattern, score: delta } of QUALITY_SCORES) {
    if (pattern.test(voiceLabel(voice))) score += delta;
  }

  return score;
}

function pickBestInFamily(
  voices: SpeechSynthesisVoice[],
  isMember: (voice: SpeechSynthesisVoice) => boolean,
  lang: string,
): SpeechSynthesisVoice | null {
  const family = voices.filter(isMember);
  if (family.length === 0) return null;

  const premium = family.filter(isPremiumLikeVoice);
  const pool = premium.length > 0 ? premium : family;
  const ranked = pool
    .map((voice) => ({ voice, score: scoreVoice(voice, lang) }))
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.voice ?? null;
}

function canUseSystemDefaultVoice(voices: SpeechSynthesisVoice[], lang: string): boolean {
  if (voices.length === 0) return false;
  const langPrefix = lang.split('-')[0].toLowerCase();
  return voices.some((v) => v.lang.replace('_', '-').toLowerCase().startsWith(langPrefix));
}

/** Lilian → Yue → 系统默认；三者皆不可用则返回 null */
export function pickSpeakVoice(
  voices: SpeechSynthesisVoice[],
  lang: string,
): SpeakVoicePick | null {
  const lilian = pickBestInFamily(voices, isLilianVoice, lang);
  if (lilian) return { voice: lilian, source: 'lilian' };

  const yue = pickBestInFamily(voices, isYueVoice, lang);
  if (yue) return { voice: yue, source: 'yue' };

  if (canUseSystemDefaultVoice(voices, lang)) {
    return { voice: null, source: 'default' };
  }

  return null;
}

export function waitForVoices(syn: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
  const existing = syn.getVoices();
  if (existing.length > 0) return Promise.resolve(existing);

  return new Promise((resolve) => {
    const finish = () => {
      syn.removeEventListener('voiceschanged', finish);
      resolve(syn.getVoices());
    };
    syn.addEventListener('voiceschanged', finish);
    window.setTimeout(finish, 800);
  });
}
