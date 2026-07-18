import { useCallback, useRef } from 'react';
import { float32MonoToPCM16Mono16k } from '@/utils/pcmDownsample';
import type { DictationShared } from './shared';
import { hasVolcAsrStack, volcCredsConfigured } from './stacks';
import type { SpeechDictationLabels, VolcAsrDictationConfig } from './types';
import { addVolcPcmTapWorklet, VOLC_CHUNK_SAMPLES, VOLC_MAX_PENDING_SAMPLES, VOLC_PCM_TAP_PROCESSOR } from './volcWorklet';

/** 自上次识别结果发生变化起，静默该时长则自动结束火山会话（仍可随时点按钮结束） */
const VOLC_SILENCE_MS = 3000;

function retryableVolcStartError(msg: string | undefined) {
  const m = String(msg ?? '').toLowerCase();
  return (
    m.includes('timeout') ||
    m.includes('session aborted') ||
    m.includes('session superseded') ||
    m.includes('websocket closed')
  );
}

/** 火山大模型双向流式 ASR 路径：AudioWorklet 采 PCM → IPC 推块 → 文本回灌输入框 */
export function useVolcAsrPath(shared: DictationShared, labels: SpeechDictationLabels) {
  const {
    mediaStreamRef,
    committedRef,
    prefixRef,
    suffixRef,
    stopRequestedRef,
    dictationKindRef,
    getVolcCfgRef,
    textareaRef,
    setInput,
    setListening,
    setStarting,
    setBanner,
    clearBanner,
    captureAnchor,
    finishDictationSession,
  } = shared;

  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioTapRef = useRef<AudioWorkletNode | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  /** volc：待发送 PCM；主进程单次至少 64 样本 */
  const volcPendingPcmRef = useRef<number[]>([]);
  const volcIpcCleanupRef = useRef<Array<() => void>>([]);
  /** 唤醒确认 TTS 播放期间并行预拉麦克风（WebSocket 须在 TTS 后再建，否则长时间无音频会失效） */
  const wakePreparedStreamRef = useRef<MediaStream | null>(null);
  const wakeMicPrepareRef = useRef<Promise<void> | null>(null);
  /** 识别结果上一次 payload（trimmed），用于检测「有新的识别下发」并重置静默计时 */
  const lastVolcPayloadRef = useRef<string>('__VOLC_IDLE_SENTINEL__');
  const volcIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gracefulEndVolcSessionRef = useRef(() => Promise.resolve());

  const clearVolcIdleTimer = useCallback(() => {
    if (volcIdleTimerRef.current !== null) {
      clearTimeout(volcIdleTimerRef.current);
      volcIdleTimerRef.current = null;
    }
  }, []);

  const discardWakePreparedMic = useCallback(() => {
    wakePreparedStreamRef.current?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    });
    wakePreparedStreamRef.current = null;
    wakeMicPrepareRef.current = null;
  }, []);

  const startVolcAsrSession = useCallback(async (vcfg: VolcAsrDictationConfig) => {
    const volcCreds = {
      appKey: vcfg.appKey.trim(),
      accessKey: vcfg.accessKey.trim(),
      resourceId: vcfg.resourceId.trim(),
    };
    let startRes = await window.electron.volcAsrStart(volcCreds);
    if (!startRes.ok && retryableVolcStartError(startRes.error)) {
      await new Promise((r) => window.setTimeout(r, 280));
      startRes = await window.electron.volcAsrStart(volcCreds);
    }
    return startRes;
  }, []);

  /** TTS 确认语播放期间并行 getUserMedia，唤醒后听写可复用该流 */
  const prepareWakeMic = useCallback((): Promise<void> => {
    if (wakeMicPrepareRef.current) return wakeMicPrepareRef.current;
    const p = (async () => {
      const existing = wakePreparedStreamRef.current;
      if (existing?.active) return;
      discardWakePreparedMic();
      try {
        wakePreparedStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        wakePreparedStreamRef.current = null;
      }
    })();
    wakeMicPrepareRef.current = p;
    return p;
  }, [discardWakePreparedMic]);

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
  }, [mediaStreamRef]);

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
    if (pend.length > VOLC_MAX_PENDING_SAMPLES) {
      pend.splice(0, pend.length - VOLC_MAX_PENDING_SAMPLES);
    }
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
    [setInput, textareaRef, committedRef, prefixRef, suffixRef, stopRequestedRef]
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
    stopRequestedRef.current = false;
    finishDictationSession();
  }, [cleanupVolcIpc, clearVolcIdleTimer, finishDictationSession, flushVolcRemainder, releaseVolcAudio, stopRequestedRef, dictationKindRef]);

  gracefulEndVolcSessionRef.current = gracefulEndVolcSession;

  const armVolcIdleTimer = useCallback(() => {
    clearVolcIdleTimer();
    volcIdleTimerRef.current = setTimeout(() => {
      volcIdleTimerRef.current = null;
      if (dictationKindRef.current !== 'volc' || stopRequestedRef.current) return;
      void gracefulEndVolcSessionRef.current();
    }, VOLC_SILENCE_MS);
  }, [clearVolcIdleTimer, dictationKindRef, stopRequestedRef]);

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
    [applyVolcCommitted, armVolcIdleTimer, dictationKindRef, stopRequestedRef]
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
    const prepared = wakePreparedStreamRef.current;
    if (prepared?.active) {
      stream = prepared;
      wakePreparedStreamRef.current = null;
      wakeMicPrepareRef.current = null;
    } else {
      discardWakePreparedMic();
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        setBanner(labels.transcribeDenied);
        setStarting(false);
        return;
      }
    }
    mediaStreamRef.current = stream;

    const startRes = await startVolcAsrSession(vcfg);

    if (!startRes.ok) {
      releaseVolcAudio();
      const benign =
        startRes.error === 'session aborted' || startRes.error === 'session superseded';
      if (!benign) {
        setBanner(labels.genericError + (startRes.error ? `: ${startRes.error}` : ''));
      }
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
      stopRequestedRef.current = false;
      finishDictationSession();
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
    finishDictationSession,
    releaseVolcAudio,
    teardownVolcFully,
    textareaRef,
    discardWakePreparedMic,
    startVolcAsrSession,
    mediaStreamRef,
    dictationKindRef,
    getVolcCfgRef,
    setBanner,
    setListening,
    setStarting,
    stopRequestedRef,
  ]);

  return {
    startVolcRecording,
    gracefulEndVolcSession,
    teardownVolcFully,
    prepareWakeMic,
    discardWakePreparedMic,
  };
}
