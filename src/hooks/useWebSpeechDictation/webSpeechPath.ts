import { useCallback } from 'react';
import type { DictationShared } from './shared';
import { getRecognitionCtor, speechLangFromUiLocale } from './stacks';
import type { SpeechDictationLabels } from './types';

/** Chromium Web Speech 路径：免配置但依赖云端服务，某些网络环境不可用 */
export function useWebSpeechPath(shared: DictationShared, labels: SpeechDictationLabels, uiLocale: string) {
  const {
    recognitionRef,
    committedRef,
    prefixRef,
    suffixRef,
    stopRequestedRef,
    dictationKindRef,
    textareaRef,
    setInput,
    setListening,
    setBanner,
    clearBanner,
    captureAnchor,
    finishDictationSession,
  } = shared;

  const startWebRecognition = useCallback(() => {
    clearBanner();
    const Ctor = getRecognitionCtor();
    const ta = textareaRef.current;
    if (!Ctor || !ta) return;
    if (!captureAnchor()) return;

    const rec = new Ctor();
    rec.lang = speechLangFromUiLocale(uiLocale);
    rec.continuous = true;
    rec.interimResults = true;

    dictationKindRef.current = 'web';

    rec.onresult = (e: SpeechRecognitionEvent) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const chunk = e.results[i];
        if (!chunk?.[0]) continue;
        const text = chunk[0].transcript;
        if (chunk.isFinal) committedRef.current += text;
        else interim += text;
      }
      const middle = `${committedRef.current}${interim}`;
      const next = `${prefixRef.current}${middle}${suffixRef.current}`;
      setInput(next);
      const caret = prefixRef.current.length + middle.length;
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el || stopRequestedRef.current) return;
        el.setSelectionRange(caret, caret);
      });
    };

    rec.onerror = (ev: SpeechRecognitionErrorEvent) => {
      const code = ev.error;
      if (code === 'aborted') return;
      if (code === 'not-allowed') setBanner(labels.needMic);
      else if (code === 'network') setBanner(labels.networkOrService);
      else if (code === 'no-speech') setBanner(labels.noSpeech);
      else setBanner(labels.genericError + (code ? ` (${code})` : ''));
    };

    rec.onend = () => {
      recognitionRef.current = null;
      if (dictationKindRef.current === 'web') dictationKindRef.current = 'none';
      finishDictationSession();
    };

    recognitionRef.current = rec;
    try {
      rec.start();
      setListening(true);
      ta.focus();
    } catch {
      setBanner(labels.startFailed);
      recognitionRef.current = null;
      dictationKindRef.current = 'none';
      setListening(false);
    }
  }, [
    captureAnchor,
    clearBanner,
    labels.genericError,
    labels.needMic,
    labels.networkOrService,
    labels.noSpeech,
    labels.startFailed,
    finishDictationSession,
    setInput,
    textareaRef,
    uiLocale,
    recognitionRef,
    committedRef,
    prefixRef,
    suffixRef,
    stopRequestedRef,
    dictationKindRef,
    setBanner,
    setListening,
  ]);

  return { startWebRecognition };
}
