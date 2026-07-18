import { useCallback } from 'react';
import type { DictationShared } from './shared';
import { hasApiRecordingStack } from './stacks';
import type { SpeechDictationLabels } from './types';

/** 录音 + OpenAI 兼容 /audio/transcriptions 单次转写路径 */
export function useApiRecordPath(shared: DictationShared, labels: SpeechDictationLabels, uiLocale: string) {
  const {
    mediaRecorderRef,
    mediaStreamRef,
    recordChunksRef,
    skipNextTranscriptRef,
    committedRef,
    prefixRef,
    suffixRef,
    stopRequestedRef,
    dictationKindRef,
    getCfgRef,
    textareaRef,
    setInput,
    setListening,
    setStarting,
    setBanner,
    clearBanner,
    captureAnchor,
    finishDictationSession,
    releaseMediaOnly,
  } = shared;

  const startApiRecording = useCallback(async () => {
    clearBanner();
    const ta = textareaRef.current;
    if (!ta || !hasApiRecordingStack()) {
      setBanner(labels.notSupported);
      return;
    }
    const cfg = getCfgRef.current?.() ?? null;
    if (!cfg?.apiKey?.trim()) {
      setBanner(labels.notSupported);
      return;
    }
    if (!captureAnchor()) return;

    dictationKindRef.current = 'api';
    skipNextTranscriptRef.current = false;
    recordChunksRef.current = [];

    setStarting(true);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setBanner(labels.transcribeDenied);
      dictationKindRef.current = 'none';
      setStarting(false);
      return;
    }
    mediaStreamRef.current = stream;

    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    const mime = candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
    let rec: MediaRecorder;
    try {
      rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch {
      releaseMediaOnly();
      dictationKindRef.current = 'none';
      setBanner(labels.startFailed);
      setStarting(false);
      return;
    }
    mediaRecorderRef.current = rec;

    rec.ondataavailable = (ev) => {
      if (ev.data?.size) recordChunksRef.current.push(ev.data);
    };

    rec.onerror = () => {
      setBanner(labels.transcribeFailed);
    };

    rec.onstop = () => {
      void (async () => {
        const usedMime = rec.mimeType || mime || 'audio/webm';
        const skip = skipNextTranscriptRef.current;
        skipNextTranscriptRef.current = false;
        try {
          if (skip) return;
          const blob = new Blob(recordChunksRef.current, { type: usedMime });
          const buf = Array.from(new Uint8Array(await blob.arrayBuffer()));
          const c = getCfgRef.current?.() ?? null;
          if (!c?.apiKey?.trim()) {
            setBanner(labels.transcribeFailed);
            return;
          }
          const lang = uiLocale === 'en' ? 'en' : 'zh';
          const r = await window.electron.transcribeAudio({
            audio: buf,
            mimeType: blob.type || usedMime,
            apiUrl: c.apiUrl,
            apiKey: c.apiKey.trim(),
            provider: c.provider,
            language: lang,
          });
          if (r.ok && r.text.trim()) {
            const middle = r.text.trim();
            committedRef.current = middle;
            const next = `${prefixRef.current}${middle}${suffixRef.current}`;
            setInput(next);
            const caret = prefixRef.current.length + middle.length;
            requestAnimationFrame(() => {
              const el = textareaRef.current;
              if (!el) return;
              el.setSelectionRange(caret, caret);
            });
          } else {
            const err = !r.ok ? r.error : '';
            setBanner(err ? `${labels.transcribeFailed} ${err}` : labels.transcribeFailed);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setBanner(`${labels.transcribeFailed} ${msg.slice(0, 200)}`);
        } finally {
          releaseMediaOnly();
          dictationKindRef.current = 'none';
          stopRequestedRef.current = false;
          if (!skip) finishDictationSession();
        }
      })();
    };

    try {
      rec.start(250);
      setListening(true);
      setStarting(false);
      ta.focus();
    } catch {
      releaseMediaOnly();
      dictationKindRef.current = 'none';
      setBanner(labels.startFailed);
      setStarting(false);
    }
  }, [
    captureAnchor,
    clearBanner,
    labels.notSupported,
    labels.startFailed,
    labels.transcribeDenied,
    labels.transcribeFailed,
    finishDictationSession,
    releaseMediaOnly,
    setInput,
    textareaRef,
    uiLocale,
    mediaRecorderRef,
    mediaStreamRef,
    recordChunksRef,
    skipNextTranscriptRef,
    committedRef,
    prefixRef,
    suffixRef,
    stopRequestedRef,
    dictationKindRef,
    getCfgRef,
    setBanner,
    setListening,
    setStarting,
  ]);

  return { startApiRecording };
}
