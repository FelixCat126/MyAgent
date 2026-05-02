import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ModelConfig } from '@/types';
import { float32MonoToPCM16Mono16k } from '@/utils/pcmDownsample';

/** 与 Chromium Web Speech API / i18n locale 对齐 */
function speechLangFromUiLocale(locale: string): string {
  if (locale === 'en') return 'en-US';
  return 'zh-CN';
}

type RecognitionCtor = new () => SpeechRecognition;

function getRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as Window & { webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** 独立于 hook，避免误判「可用栈」不稳定 */
function hasApiRecordingStack(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof MediaRecorder === 'undefined') return false;
  if (!navigator.mediaDevices?.getUserMedia) return false;
  return typeof window.electron?.transcribeAudio === 'function';
}

/** 火山大模型双向流式 ASR，需主进程挂载 volc-asr-* */
function hasVolcAsrStack(): boolean {
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

export type VolcAsrDictationConfig = {
  appKey: string;
  accessKey: string;
  resourceId: string;
};

function volcCredsConfigured(c: VolcAsrDictationConfig): boolean {
  return Boolean(c.appKey.trim() && c.accessKey.trim() && c.resourceId.trim());
}

const VOLC_CHUNK_SAMPLES = 3200;
/** 自上次识别结果发生变化起，静默该时长则自动结束火山会话（仍可随时点按钮结束） */
const VOLC_SILENCE_MS = 3000;

/** 避免 ScriptProcessor（已废弃）：在 Electron/macOS 上有诱发渲染进程崩溃的风险，改用 AudioWorklet */
const VOLC_PCM_TAP_PROCESSOR = 'volc-pcm-tap-v1';

const VOLC_PCM_WORKLET_CODE = `
class VolcPcmTapProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const ch0 = inputs[0]?.[0];
    if (ch0 && ch0.length > 0) {
      const copy = new Float32Array(ch0.length);
      copy.set(ch0);
      this.port.postMessage(copy.buffer, [copy.buffer]);
    }
    const out0 = outputs[0]?.[0];
    if (out0 && out0.length) out0.fill(0);
    return true;
  }
}
registerProcessor("${VOLC_PCM_TAP_PROCESSOR}", VolcPcmTapProcessor);
`;

async function addVolcPcmTapWorklet(audioCtx: AudioContext): Promise<void> {
  const blob = new Blob([VOLC_PCM_WORKLET_CODE], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  try {
    await audioCtx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

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

type Options = {
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
};

/** 录音 + OpenAI 兼容转写优先级高于 Web Speech */
export function useWebSpeechDictation({
  inputValueRef,
  textareaRef,
  setInput,
  uiLocale,
  disabled,
  isImeComposing,
  labels,
  getVolcAsrConfig,
  getApiTranscribeConfig,
}: Options) {
  const [listening, setListening] = useState(false);
  const [starting, setStarting] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const committedRef = useRef('');
  const prefixRef = useRef('');
  const suffixRef = useRef('');
  const stopRequestedRef = useRef(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordChunksRef = useRef<BlobPart[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioTapRef = useRef<AudioWorkletNode | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  /** volc：待发送 PCM；主进程单次至少 64 样本 */
  const volcPendingPcmRef = useRef<number[]>([]);
  const volcIpcCleanupRef = useRef<Array<() => void>>([]);
  /** 识别结果上一次 payload（trimmed），用于检测「有新的识别下发」并重置静默计时 */
  const lastVolcPayloadRef = useRef<string>('__VOLC_IDLE_SENTINEL__');
  const volcIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gracefulEndVolcSessionRef = useRef(() => Promise.resolve());
  /** 'volc'：火山流式；'api'：单次转写；否则 Web Speech */
  const dictationKindRef = useRef<'none' | 'web' | 'api' | 'volc'>('none');

  const getCfgRef = useRef(getApiTranscribeConfig);
  getCfgRef.current = getApiTranscribeConfig;
  const getVolcCfgRef = useRef(getVolcAsrConfig);
  getVolcCfgRef.current = getVolcAsrConfig;

  const webCtorExists = useMemo(() => Boolean(getRecognitionCtor()), []);

  const vcSnap = getVolcCfgRef.current?.() ?? null;
  const supported =
    webCtorExists ||
    (Boolean(getCfgRef.current?.()?.apiKey?.trim()) && hasApiRecordingStack()) ||
    Boolean(vcSnap && volcCredsConfigured(vcSnap) && hasVolcAsrStack());

  const clearBanner = useCallback(() => setBanner(null), []);

  const clearVolcIdleTimer = useCallback(() => {
    if (volcIdleTimerRef.current !== null) {
      clearTimeout(volcIdleTimerRef.current);
      volcIdleTimerRef.current = null;
    }
  }, []);

  /** 为 true 时 MediaRecorder.onstop 内丢弃转写结果（卸载 / 中止 / 切换会话） */
  const skipNextTranscriptRef = useRef(false);

  const releaseMediaOnly = useCallback(() => {
    mediaStreamRef.current?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    });
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;
    recordChunksRef.current = [];
  }, []);

  const cleanupVolcIpc = useCallback(() => {
    volcIpcCleanupRef.current.forEach((fn) => {
      try {
        fn();
      } catch {
        /* ignore */
      }
    });
    volcIpcCleanupRef.current = [];
  }, []);

  const releaseVolcAudio = useCallback(() => {
    try {
      audioTapRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      audioSourceRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    audioTapRef.current = null;
    audioSourceRef.current = null;
    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    if (ctx?.state !== 'closed') {
      void ctx?.close().catch(() => {});
    }
    volcPendingPcmRef.current = [];
    mediaStreamRef.current?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    });
    mediaStreamRef.current = null;
  }, []);

  const teardownVolcFully = useCallback(
    (opts: { abortSocket: boolean }) => {
      clearVolcIdleTimer();
      lastVolcPayloadRef.current = '__VOLC_IDLE_SENTINEL__';
      cleanupVolcIpc();
      releaseVolcAudio();
      if (opts.abortSocket) {
        try {
          void window.electron.volcAsrAbort();
        } catch {
          /* ignore */
        }
      }
    },
    [cleanupVolcIpc, clearVolcIdleTimer, releaseVolcAudio]
  );

  const flushVolcRemainder = useCallback(async () => {
    const rest = volcPendingPcmRef.current;
    volcPendingPcmRef.current = [];
    if (rest.length >= 64) {
      try {
        await window.electron.volcAsrPushChunk(rest);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const pushVolcPcmInts = useCallback(async (pcm: Int16Array) => {
    const pend = volcPendingPcmRef.current;
    for (let i = 0; i < pcm.length; i++) pend.push(pcm[i] ?? 0);
    while (pend.length >= VOLC_CHUNK_SAMPLES) {
      const chunk = pend.splice(0, VOLC_CHUNK_SAMPLES);
      try {
        await window.electron.volcAsrPushChunk(chunk);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const applyVolcCommitted = useCallback(
    (middle: string) => {
      committedRef.current = middle;
      const next = `${prefixRef.current}${middle}${suffixRef.current}`;
      setInput(next);
      const caret = prefixRef.current.length + middle.length;
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el || stopRequestedRef.current) return;
        el.setSelectionRange(caret, caret);
      });
    },
    [setInput, textareaRef]
  );

  const gracefulEndVolcSession = useCallback(async () => {
    clearVolcIdleTimer();
    lastVolcPayloadRef.current = '__VOLC_IDLE_SENTINEL__';
    stopRequestedRef.current = true;
    try {
      audioTapRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      audioSourceRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    audioTapRef.current = null;
    audioSourceRef.current = null;
    await flushVolcRemainder();
    try {
      await window.electron.volcAsrFinish();
    } catch {
      /* ignore */
    }
    cleanupVolcIpc();
    releaseVolcAudio();
    if (dictationKindRef.current === 'volc') dictationKindRef.current = 'none';
    setListening(false);
    stopRequestedRef.current = false;
  }, [cleanupVolcIpc, clearVolcIdleTimer, flushVolcRemainder, releaseVolcAudio]);

  gracefulEndVolcSessionRef.current = gracefulEndVolcSession;

  const armVolcIdleTimer = useCallback(() => {
    clearVolcIdleTimer();
    volcIdleTimerRef.current = setTimeout(() => {
      volcIdleTimerRef.current = null;
      if (dictationKindRef.current !== 'volc' || stopRequestedRef.current) return;
      void gracefulEndVolcSessionRef.current();
    }, VOLC_SILENCE_MS);
  }, [clearVolcIdleTimer]);

  const abortRecognition = useCallback(() => {
    setStarting(false);
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
  }, [releaseMediaOnly, teardownVolcFully]);

  const captureAnchor = useCallback(() => {
    const ta = textareaRef.current;
    const snapshot = inputValueRef.current;
    if (!ta) return false;
    let startSel = ta.selectionStart;
    let endSel = ta.selectionEnd;
    if (startSel > endSel) [startSel, endSel] = [endSel, startSel];
    prefixRef.current = snapshot.slice(0, startSel);
    suffixRef.current = snapshot.slice(endSel);
    committedRef.current = '';
    stopRequestedRef.current = false;
    return true;
  }, [inputValueRef, textareaRef]);

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
      setListening(false);
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
    setInput,
    textareaRef,
    uiLocale,
  ]);

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
          setListening(false);
          stopRequestedRef.current = false;
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
    releaseMediaOnly,
    setInput,
    textareaRef,
    uiLocale,
  ]);

  const dispatchVolcRawText = useCallback(
    (rawUnclean: string) => {
      if (dictationKindRef.current !== 'volc' || stopRequestedRef.current) return;
      const t = String(rawUnclean ?? '').trim();
      if (t !== lastVolcPayloadRef.current) {
        lastVolcPayloadRef.current = t;
        armVolcIdleTimer();
      }
      applyVolcCommitted(t);
    },
    [applyVolcCommitted, armVolcIdleTimer]
  );

  const dispatchVolcRawTextRef = useRef(dispatchVolcRawText);
  dispatchVolcRawTextRef.current = dispatchVolcRawText;

  const startVolcRecording = useCallback(async () => {
    clearBanner();
    const ta = textareaRef.current;
    const fn = getVolcCfgRef.current;
    const vcfg = fn?.() ?? null;

    if (!ta || !hasVolcAsrStack() || !vcfg || !volcCredsConfigured(vcfg)) {
      setBanner(labels.notSupported);
      return;
    }

    if (!captureAnchor()) return;

    volcPendingPcmRef.current = [];
    cleanupVolcIpc();

    setStarting(true);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setBanner(labels.transcribeDenied);
      setStarting(false);
      return;
    }
    mediaStreamRef.current = stream;

    const startRes = await window.electron.volcAsrStart({
      appKey: vcfg.appKey.trim(),
      accessKey: vcfg.accessKey.trim(),
      resourceId: vcfg.resourceId.trim(),
    });

    if (!startRes.ok) {
      releaseVolcAudio();
      setBanner(labels.genericError + (startRes.error ? `: ${startRes.error}` : ''));
      setStarting(false);
      return;
    }

    dictationKindRef.current = 'volc';
    lastVolcPayloadRef.current = '__VOLC_IDLE_SENTINEL__';
    armVolcIdleTimer();

    const offTxt = window.electron.onMessage('volc-asr-text', (...args: unknown[]) =>
      dispatchVolcRawTextRef.current(String(args[0] ?? ''))
    );
    const offErr = window.electron.onMessage('volc-asr-error', (...args: unknown[]) => {
      const msg = String(args[0] ?? '').trim();
      setBanner(msg ? `${labels.genericError}: ${msg.slice(0, 240)}` : labels.genericError);
      if (dictationKindRef.current === 'volc') {
        teardownVolcFully({ abortSocket: true });
        dictationKindRef.current = 'none';
        setListening(false);
        stopRequestedRef.current = false;
      }
    });
    const offEnd = window.electron.onMessage('volc-asr-ended', () => {
      if (dictationKindRef.current !== 'volc') return;
      clearVolcIdleTimer();
      lastVolcPayloadRef.current = '__VOLC_IDLE_SENTINEL__';
      cleanupVolcIpc();
      releaseVolcAudio();
      dictationKindRef.current = 'none';
      setListening(false);
      stopRequestedRef.current = false;
    });
    volcIpcCleanupRef.current.push(offTxt, offErr, offEnd);

    let audioCtx: AudioContext;
    try {
      audioCtx = new AudioContext();
    } catch {
      teardownVolcFully({ abortSocket: true });
      dictationKindRef.current = 'none';
      setBanner(labels.startFailed);
      setStarting(false);
      return;
    }
    audioCtxRef.current = audioCtx;
    await audioCtx.resume().catch(() => {});

    try {
      await addVolcPcmTapWorklet(audioCtx);
    } catch {
      teardownVolcFully({ abortSocket: true });
      dictationKindRef.current = 'none';
      setListening(false);
      setBanner(labels.startFailed);
      setStarting(false);
      return;
    }

    let tap: AudioWorkletNode;
    try {
      tap = new AudioWorkletNode(audioCtx, VOLC_PCM_TAP_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelInterpretation: 'speakers',
        channelCountMode: 'explicit',
      });
    } catch {
      teardownVolcFully({ abortSocket: true });
      dictationKindRef.current = 'none';
      setListening(false);
      setBanner(labels.startFailed);
      setStarting(false);
      return;
    }
    audioTapRef.current = tap;

    tap.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      if (dictationKindRef.current !== 'volc' || stopRequestedRef.current) return;
      const buf = ev.data;
      if (!buf || !(buf instanceof ArrayBuffer) || buf.byteLength < 4) return;
      const mono = new Float32Array(buf);
      const pcm = float32MonoToPCM16Mono16k(mono, audioCtx.sampleRate);
      if (pcm.length) void pushVolcPcmInts(pcm);
    };

    const source = audioCtx.createMediaStreamSource(stream);
    audioSourceRef.current = source;
    const silent = audioCtx.createGain();
    silent.gain.value = 0;

    source.connect(tap);
    tap.connect(silent);
    silent.connect(audioCtx.destination);

    try {
      setListening(true);
      setStarting(false);
      requestAnimationFrame(() => {
        try {
          ta.focus();
        } catch {
          /* ignore */
        }
      });
    } catch {
      teardownVolcFully({ abortSocket: true });
      dictationKindRef.current = 'none';
      setBanner(labels.startFailed);
      setStarting(false);
    }
  }, [
    armVolcIdleTimer,
    captureAnchor,
    cleanupVolcIpc,
    clearBanner,
    clearVolcIdleTimer,
    labels.genericError,
    labels.notSupported,
    labels.startFailed,
    labels.transcribeDenied,
    pushVolcPcmInts,
    releaseVolcAudio,
    teardownVolcFully,
    textareaRef,
  ]);

  const start = useCallback(() => {
    clearBanner();
    if (disabled) return;
    if (isImeComposing?.()) return;
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
  }, [
    clearBanner,
    disabled,
    isImeComposing,
    labels.notSupported,
    startVolcRecording,
    startApiRecording,
    startWebRecognition,
    supported,
    webCtorExists,
  ]);

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
  }, [abortRecognition, gracefulEndVolcSession]);

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
  }, [abortRecognition, disabled, listening, starting, stopListeningSoft]);

  return { supported, listening, starting, banner, toggle, abort: abortRecognition, clearBanner };
}
