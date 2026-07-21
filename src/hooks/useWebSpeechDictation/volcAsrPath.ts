import { useCallback, useRef } from 'react';
import type { DictationShared } from './shared';
import { hasVolcAsrStack, volcCredsConfigured } from './stacks';
import type { SpeechDictationLabels, VolcAsrDictationConfig } from './types';
import { createVolcPcmSession, type VolcPcmSession } from '../volcPcmSession';

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

/**
 * 火山大模型双向流式 ASR 路径：文本回灌输入框、静默自动收尾、唤醒预热麦复用。
 * PCM 采集管线与 useVoiceWake 共享 volcPcmSession，本 hook 只保留听写策略。
 */
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

  const volcSessionRef = useRef<VolcPcmSession | null>(null);
  if (!volcSessionRef.current) volcSessionRef.current = createVolcPcmSession();

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

  const releaseVolcAudio = useCallback(() => {
    volcSessionRef.current?.releaseAudio();
    mediaStreamRef.current = null;
  }, [mediaStreamRef]);

  const teardownVolcFully = useCallback(
    (opts: { abortSocket: boolean }) => {
      clearVolcIdleTimer();
      lastVolcPayloadRef.current = '__VOLC_IDLE_SENTINEL__';
      volcSessionRef.current?.teardown(opts);
      mediaStreamRef.current = null;
    },
    [clearVolcIdleTimer, mediaStreamRef]
  );

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
    const session = volcSessionRef.current;
    clearVolcIdleTimer();
    lastVolcPayloadRef.current = '__VOLC_IDLE_SENTINEL__';
    stopRequestedRef.current = true;
    session?.disconnectTap();
    await session?.flushRemainder();
    try {
      await window.electron.volcAsrFinish();
    } catch {
      /* ignore */
    }
    session?.cleanupIpc();
    releaseVolcAudio();
    if (dictationKindRef.current === 'volc') dictationKindRef.current = 'none';
    stopRequestedRef.current = false;
    finishDictationSession();
  }, [clearVolcIdleTimer, finishDictationSession, releaseVolcAudio, stopRequestedRef, dictationKindRef]);

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
    const session = volcSessionRef.current;
    clearBanner();
    const ta = textareaRef.current;
    const fn = getVolcCfgRef.current;
    const vcfg = fn?.() ?? null;

    if (!session || !ta || !hasVolcAsrStack() || !vcfg || !volcCredsConfigured(vcfg)) {
      setBanner(labels.notSupported);
      return;
    }

    if (!captureAnchor()) return;

    session.cleanupIpc();

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

    session.listenIpc({
      onText: (text) => dispatchVolcRawTextRef.current(text),
      onError: (rawMsg) => {
        const msg = rawMsg.trim();
        setBanner(msg ? `${labels.genericError}: ${msg.slice(0, 240)}` : labels.genericError);
        if (dictationKindRef.current === 'volc') {
          teardownVolcFully({ abortSocket: true });
          dictationKindRef.current = 'none';
          setListening(false);
          stopRequestedRef.current = false;
        }
      },
      onEnded: () => {
        if (dictationKindRef.current !== 'volc') return;
        clearVolcIdleTimer();
        lastVolcPayloadRef.current = '__VOLC_IDLE_SENTINEL__';
        session.cleanupIpc();
        releaseVolcAudio();
        dictationKindRef.current = 'none';
        stopRequestedRef.current = false;
        finishDictationSession();
      },
    });

    try {
      await session.buildAudioPipeline(
        stream,
        () => dictationKindRef.current === 'volc' && !stopRequestedRef.current
      );
    } catch {
      teardownVolcFully({ abortSocket: true });
      dictationKindRef.current = 'none';
      setListening(false);
      setBanner(labels.startFailed);
      setStarting(false);
      return;
    }

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
    clearBanner,
    clearVolcIdleTimer,
    labels.genericError,
    labels.notSupported,
    labels.startFailed,
    labels.transcribeDenied,
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
