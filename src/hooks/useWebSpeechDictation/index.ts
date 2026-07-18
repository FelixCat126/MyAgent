import { useCallback, useEffect, useMemo } from 'react';
import { useApiRecordPath } from './apiRecordPath';
import { useDictationShared } from './shared';
import { getRecognitionCtor, hasApiRecordingStack, hasVolcAsrStack, volcCredsConfigured } from './stacks';
import type { SpeechDictationOptions, SpeechDictationStartOptions } from './types';
import { useVolcAsrPath } from './volcAsrPath';
import { useWebSpeechPath } from './webSpeechPath';

/** 录音 + OpenAI 兼容转写优先级高于 Web Speech；火山流式（配置齐备）最高 */
export function useWebSpeechDictation(options: SpeechDictationOptions) {
  const { uiLocale, disabled, isImeComposing, labels } = options;
  const shared = useDictationShared(options);
  const {
    listening,
    starting,
    banner,
    setListening,
    setStarting,
    setBanner,
    autoSendOnEndRef,
    endNotifiedRef,
    recognitionRef,
    stopRequestedRef,
    mediaRecorderRef,
    skipNextTranscriptRef,
    dictationKindRef,
    getCfgRef,
    getVolcCfgRef,
    clearBanner,
    releaseMediaOnly,
  } = shared;

  const { startWebRecognition } = useWebSpeechPath(shared, labels, uiLocale);
  const { startApiRecording } = useApiRecordPath(shared, labels, uiLocale);
  const {
    startVolcRecording,
    gracefulEndVolcSession,
    teardownVolcFully,
    prepareWakeMic,
    discardWakePreparedMic,
  } = useVolcAsrPath(shared, labels);

  const webCtorExists = useMemo(() => Boolean(getRecognitionCtor()), []);

  const vcSnap = getVolcCfgRef.current?.() ?? null;
  const supported =
    webCtorExists ||
    (Boolean(getCfgRef.current?.()?.apiKey?.trim()) && hasApiRecordingStack()) ||
    Boolean(vcSnap && volcCredsConfigured(vcSnap) && hasVolcAsrStack());

  const abortRecognition = useCallback(() => {
    setStarting(false);
    autoSendOnEndRef.current = false;
    endNotifiedRef.current = false;
    discardWakePreparedMic();
    if (dictationKindRef.current === 'none') {
      releaseMediaOnly();
    }
    stopRequestedRef.current = true;
    if (dictationKindRef.current === 'volc') {
      teardownVolcFully({ abortSocket: true });
      dictationKindRef.current = 'none';
      setListening(false);
      stopRequestedRef.current = false;
      return;
    }
    if (dictationKindRef.current === 'api') {
      skipNextTranscriptRef.current = true;
      try {
        mediaRecorderRef.current?.stop();
      } catch {
        releaseMediaOnly();
      }
      dictationKindRef.current = 'none';
      setListening(false);
      stopRequestedRef.current = false;
      return;
    }
    dictationKindRef.current = 'none';
    const r = recognitionRef.current;
    if (r) {
      try {
        r.abort();
      } catch {
        try {
          r.stop();
        } catch {
          /* ignore */
        }
      }
    }
    recognitionRef.current = null;
    setListening(false);
    stopRequestedRef.current = false;
  }, [discardWakePreparedMic, releaseMediaOnly, teardownVolcFully, autoSendOnEndRef, dictationKindRef, endNotifiedRef, mediaRecorderRef, recognitionRef, setListening, setStarting, skipNextTranscriptRef, stopRequestedRef]);

  const start = useCallback(
    (opts?: SpeechDictationStartOptions) => {
      clearBanner();
      if (disabled) return;
      if (isImeComposing?.()) return;
      autoSendOnEndRef.current = Boolean(opts?.fromWake);
      endNotifiedRef.current = false;
      if (!supported) {
        setBanner(labels.notSupported);
        return;
      }
      const volcGuess = getVolcCfgRef.current?.() ?? null;
      if (volcGuess && volcCredsConfigured(volcGuess) && hasVolcAsrStack()) {
        void startVolcRecording();
        return;
      }
      const fn = getCfgRef.current;
      const cfg = fn?.() ?? null;
      if (Boolean(cfg?.apiKey?.trim()) && hasApiRecordingStack()) {
        void startApiRecording();
        return;
      }
      if (webCtorExists) {
        startWebRecognition();
        return;
      }
      setBanner(labels.notSupported);
    },
    [
      clearBanner,
      disabled,
      isImeComposing,
      labels.notSupported,
      startVolcRecording,
      startApiRecording,
      startWebRecognition,
      supported,
      webCtorExists,
      autoSendOnEndRef,
      endNotifiedRef,
      getCfgRef,
      getVolcCfgRef,
      setBanner,
    ]
  );

  const stopListeningSoft = useCallback(() => {
    stopRequestedRef.current = true;
    if (dictationKindRef.current === 'volc') {
      void gracefulEndVolcSession();
      return;
    }
    if (dictationKindRef.current === 'api') {
      try {
        mediaRecorderRef.current?.stop();
      } catch {
        abortRecognition();
      }
      return;
    }
    const r = recognitionRef.current;
    if (r) {
      try {
        r.stop();
      } catch {
        abortRecognition();
      }
    }
  }, [abortRecognition, gracefulEndVolcSession, dictationKindRef, mediaRecorderRef, recognitionRef, stopRequestedRef]);

  const toggle = useCallback(() => {
    if (listening) {
      stopListeningSoft();
      return;
    }
    start();
  }, [listening, start, stopListeningSoft]);

  useEffect(() => {
    return () => {
      abortRecognition();
    };
  }, [abortRecognition]);

  useEffect(() => {
    if (!disabled) return;
    if (listening) {
      stopListeningSoft();
      return;
    }
    if (starting) abortRecognition();
  }, [abortRecognition, discardWakePreparedMic, disabled, listening, starting, stopListeningSoft]);

  return {
    supported,
    listening,
    starting,
    banner,
    toggle,
    start,
    prepareWakeMic,
    abort: abortRecognition,
    clearBanner,
  };
}
