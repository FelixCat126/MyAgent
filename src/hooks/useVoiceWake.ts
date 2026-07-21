import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getRecognitionCtor,
  hasVolcAsrStack,
  volcCredsConfigured,
  type VolcAsrDictationConfig,
} from './useWebSpeechDictation';
import { speechLangFromUiLocale } from '@/utils/speechVoice';
import { createVolcPcmSession, type VolcPcmSession } from './volcPcmSession';

/** 唤醒词比对前归一化：去空白/常见标点，英文小写 */
export function normalizeWakeText(s: string): string {
  return s
    .replace(/[\s\u3000,.!?;:'"·、。，！？；：""''「」【】]/g, '')
    .toLowerCase();
}

export function detectWakePhrase(transcript: string, phrase: string): boolean {
  const p = normalizeWakeText(phrase);
  if (!p) return false;
  return normalizeWakeText(transcript).includes(p);
}

/** 「小媛」等同音/近音写法，ASR 常误写成这些字 */
const XIAOYUAN_VARIANTS = [
  '小媛', '小元', '小源', '晓媛', '晓园', '小园', '小猿', '小远', '小缘', '小原', '小圆', '小员',
];

/** 「小媛小媛」常见 ASR 整句误识别 */
const XIAOYUAN_DOUBLE_PATTERNS = [
  '小媛小媛', '小园小园', '小元小元', '小源小源', '晓媛晓媛', '晓园晓园', '小猿小猿', '小远小远',
  '小园,小园', '小元,小元', '小源,小源',
];

function buildWakeHotwords(phrase: string): string[] {
  const p = phrase.trim();
  const set = new Set<string>();
  if (!p) return [];
  set.add(p);

  const norm = normalizeWakeText(p);
  if (norm.length >= 4 && norm.length % 2 === 0) {
    const halfNorm = norm.slice(0, norm.length / 2);
    if (halfNorm === norm.slice(norm.length / 2)) {
      const halfOrig = p.slice(0, Math.ceil(p.length / 2)).trim();
      if (halfOrig) set.add(halfOrig);
    }
  }

  if (norm === '小媛小媛') {
    set.add('小媛');
    for (const pat of XIAOYUAN_DOUBLE_PATTERNS) set.add(pat.replace(/,/g, ''));
  }
  return [...set];
}

/**
 * 宽松唤醒匹配：精确包含 → 预置整句同音 → 重复片段计数 → 正则「小X小X」。
 */
export function detectWakePhraseLoose(transcript: string, phrase: string): boolean {
  if (detectWakePhrase(transcript, phrase)) return true;
  const p = normalizeWakeText(phrase);
  if (!p) return false;
  const norm = normalizeWakeText(transcript);
  const tail = norm.slice(-32);

  if (normalizeWakeText(phrase) === '小媛小媛') {
    for (const pat of XIAOYUAN_DOUBLE_PATTERNS) {
      if (tail.includes(normalizeWakeText(pat))) return true;
    }
    if (/小[园元原缘远圆员袁源媛晓圆]{1}小[园元原缘远圆员袁源媛晓圆]{1}/.test(tail)) return true;
  }

  /** 短语形如 AB（重复两次）→ 统计同音片段命中次数 */
  if (p.length >= 4 && p.length % 2 === 0) {
    const half = p.slice(0, p.length / 2);
    if (half === p.slice(p.length / 2)) {
      const variants =
        half === normalizeWakeText('小媛') ? XIAOYUAN_VARIANTS : [half];
      let hits = 0;
      for (const v of variants) {
        const nv = normalizeWakeText(v);
        let idx = 0;
        while ((idx = tail.indexOf(nv, idx)) !== -1) {
          hits += 1;
          idx += nv.length;
        }
      }
      if (hits >= 2) return true;
      /** 只识别出一次完整重复短语（如「小园小园」） */
      if (hits >= 1 && tail.length >= half.length * 2) return true;
    }
  }

  return false;
}

const WAKE_COOLDOWN_MS = 2500;
const RESTART_DELAY_MS = 450;
const RESTART_AFTER_ERROR_MS = 1400;
/** 火山 full 文本累积超过该长度仍未命中唤醒词则重置会话，避免旧内容干扰 */
const VOLC_WAKE_RESET_CHARS = 56;

export type VoiceWakeEngine = 'volc' | 'web' | 'none';

type UseVoiceWakeOptions = {
  enabled: boolean;
  phrase: string;
  uiLocale: string;
  paused: boolean;
  onWake: () => void;
  /** 火山密钥齐备时优先走火山监听（Electron 下 Web Speech 常不可用） */
  getVolcAsrConfig?: () => VolcAsrDictationConfig | null;
};

/**
 * 语音唤醒：后台监听唤醒词，命中后回调 onWake。
 * - **优先火山 ASR**（与听写同栈，Electron/macOS 可靠）
 * - 无火山时回退 Web Speech continuous
 */
export function useVoiceWake({
  enabled,
  phrase,
  uiLocale,
  paused,
  onWake,
  getVolcAsrConfig,
}: UseVoiceWakeOptions) {
  const effectivePhrase = phrase.trim();
  const [listening, setListening] = useState(false);
  const [starting, setStarting] = useState(false);
  const [wakeError, setWakeError] = useState<string | null>(null);
  const [engine, setEngine] = useState<VoiceWakeEngine>('none');
  /** 最近一次火山回调的识别文本（截断），便于确认 ASR 是否听到唤醒词 */
  const [lastWakeHeard, setLastWakeHeard] = useState('');

  const shouldRunRef = useRef(false);
  const wakeSessionRef = useRef(0);
  const cooldownUntilRef = useRef(0);
  const lastVolcFullRef = useRef('');
  const onWakeRef = useRef(onWake);
  onWakeRef.current = onWake;
  const phraseRef = useRef(effectivePhrase);
  phraseRef.current = effectivePhrase;
  const uiLocaleRef = useRef(uiLocale);
  uiLocaleRef.current = uiLocale;
  const getVolcCfgRef = useRef(getVolcAsrConfig);
  getVolcCfgRef.current = getVolcAsrConfig;

  const isWakeStale = useCallback((sessionId: number) => {
    return sessionId !== wakeSessionRef.current || !shouldRunRef.current;
  }, []);

  /** Web Speech */
  const recRef = useRef<SpeechRecognition | null>(null);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Volc wake：PCM 采集管线收敛到共享会话；本 hook 只保留文本唤醒策略 */
  const volcActiveRef = useRef(false);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const volcSessionRef = useRef<VolcPcmSession | null>(null);
  if (!volcSessionRef.current) volcSessionRef.current = createVolcPcmSession();

  const pickEngine = useCallback((): VoiceWakeEngine => {
    const v = getVolcCfgRef.current?.() ?? null;
    if (v && volcCredsConfigured(v) && hasVolcAsrStack()) return 'volc';
    if (getRecognitionCtor()) return 'web';
    return 'none';
  }, []);

  const clearRestartTimer = useCallback(() => {
    if (restartTimerRef.current !== null) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }, []);

  const teardownVolcWake = useCallback((opts: { abortSocket: boolean }) => {
    volcActiveRef.current = false;
    volcSessionRef.current?.teardown(opts);
    /** 管线未建成时流只挂在 mediaStreamRef 上，这里兜底停轨，避免麦克风泄漏 */
    mediaStreamRef.current?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    });
    mediaStreamRef.current = null;
  }, []);

  const tryWakeFromText = useCallback(
    (raw: string) => {
      if (Date.now() < cooldownUntilRef.current) return false;
      const chunk = String(raw ?? '').trim();
      if (!chunk) return false;
      if (!detectWakePhraseLoose(chunk, phraseRef.current)) return false;
      cooldownUntilRef.current = Date.now() + WAKE_COOLDOWN_MS;
      shouldRunRef.current = false;
      lastVolcFullRef.current = '';
      setLastWakeHeard('');
      void (async () => {
        teardownVolcWake({ abortSocket: true });
        stopWebRef.current();
        setListening(false);
        setStarting(false);
        onWakeRef.current();
      })();
      return true;
    },
    [teardownVolcWake]
  );

  const tryWakeFromTextRef = useRef(tryWakeFromText);
  tryWakeFromTextRef.current = tryWakeFromText;

  const startVolcWakeRef = useRef<(sessionId: number) => Promise<void>>(async () => {});

  const ingestVolcWakeText = useCallback(
    (raw: string) => {
      if (!volcActiveRef.current) return;
      const text = String(raw ?? '').trim();
      if (!text) return;
      setLastWakeHeard(text.length > 48 ? `…${text.slice(-48)}` : text);

      const prev = lastVolcFullRef.current;
      const delta = text.startsWith(prev) ? text.slice(prev.length).trim() : text;
      lastVolcFullRef.current = text;

      const candidates = [delta, text.slice(-32), text];
      for (const c of candidates) {
        if (c && tryWakeFromTextRef.current(c)) return;
      }

      if (text.length >= VOLC_WAKE_RESET_CHARS && shouldRunRef.current) {
        lastVolcFullRef.current = '';
        void (async () => {
          teardownVolcWake({ abortSocket: true });
          if (shouldRunRef.current) void startVolcWakeRef.current(wakeSessionRef.current);
        })();
      }
    },
    [teardownVolcWake]
  );

  const ingestVolcWakeTextRef = useRef(ingestVolcWakeText);
  ingestVolcWakeTextRef.current = ingestVolcWakeText;

  const stopWeb = useCallback(() => {
    clearRestartTimer();
    const r = recRef.current;
    recRef.current = null;
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
  }, [clearRestartTimer]);

  const stopWebRef = useRef(stopWeb);
  stopWebRef.current = stopWeb;

  const stopAll = useCallback(() => {
    shouldRunRef.current = false;
    stopWeb();
    teardownVolcWake({ abortSocket: true });
    setListening(false);
    setStarting(false);
  }, [stopWeb, teardownVolcWake]);

  const scheduleWebRestart = useCallback(
    (delayMs: number) => {
      clearRestartTimer();
      if (!shouldRunRef.current) return;
      restartTimerRef.current = setTimeout(() => {
        restartTimerRef.current = null;
        if (!shouldRunRef.current || recRef.current) return;
        startWebLoopRef.current();
      }, delayMs);
    },
    [clearRestartTimer]
  );

  const startWebLoopRef = useRef<() => void>(() => {});

  const startWebLoop = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor || !shouldRunRef.current || recRef.current) return;

    const rec = new Ctor();
    rec.lang = speechLangFromUiLocale(uiLocaleRef.current);
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (e: SpeechRecognitionEvent) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const text = e.results[i]?.[0]?.transcript ?? '';
        if (!text) continue;
        if (tryWakeFromTextRef.current(text)) {
          try {
            rec.stop();
          } catch {
            /* ignore */
          }
          return;
        }
      }
    };

    rec.onerror = (ev: SpeechRecognitionErrorEvent) => {
      if (ev.error === 'aborted') return;
      if (ev.error === 'not-allowed') setWakeError('mic-denied');
      else if (ev.error === 'network') setWakeError('network');
    };

    rec.onend = () => {
      recRef.current = null;
      setListening(false);
      scheduleWebRestart(RESTART_DELAY_MS);
    };

    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
      setWakeError(null);
    } catch {
      recRef.current = null;
      setListening(false);
      setWakeError('start-failed');
      scheduleWebRestart(RESTART_AFTER_ERROR_MS);
    }
  }, [scheduleWebRestart]);

  startWebLoopRef.current = startWebLoop;

  const startVolcWake = useCallback(
    async (sessionId: number) => {
      const session = volcSessionRef.current;
      if (!session || isWakeStale(sessionId)) return;
      if (volcActiveRef.current) teardownVolcWake({ abortSocket: true });

      const vcfg = getVolcCfgRef.current?.() ?? null;
      if (!vcfg || !volcCredsConfigured(vcfg) || !hasVolcAsrStack()) return;
      if (isWakeStale(sessionId)) return;

      /** 每个异步步骤后统一调用：过期则全量拆除（含麦克风停轨），漏写即泄漏 */
      const bailIfStale = (): boolean => {
        if (!isWakeStale(sessionId)) return false;
        teardownVolcWake({ abortSocket: true });
        setStarting(false);
        return true;
      };

      setStarting(true);
      setWakeError(null);
      setLastWakeHeard('');
      lastVolcFullRef.current = '';
      session.cleanupIpc();

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        if (!isWakeStale(sessionId)) setWakeError('mic-denied');
        setStarting(false);
        return;
      }
      mediaStreamRef.current = stream;
      if (bailIfStale()) return;

      const hotwords = buildWakeHotwords(phraseRef.current);
      const startRes = await window.electron.volcAsrStart({
        appKey: vcfg.appKey.trim(),
        accessKey: vcfg.accessKey.trim(),
        resourceId: vcfg.resourceId.trim(),
        wakeMode: true,
        hotwords,
      });

      if (bailIfStale()) return;
      if (!startRes.ok) {
        session.releaseAudio();
        setStarting(false);
        setWakeError('volc-start-failed');
        return;
      }

      volcActiveRef.current = true;

      session.listenIpc({
        onText: (text) => ingestVolcWakeTextRef.current(text),
        onError: (rawMsg) => {
          if (rawMsg.trim()) setWakeError('volc-error');
          if (volcActiveRef.current) {
            teardownVolcWake({ abortSocket: true });
            setListening(false);
            setStarting(false);
          }
        },
        onEnded: () => {
          if (!volcActiveRef.current) return;
          const sid = wakeSessionRef.current;
          teardownVolcWake({ abortSocket: false });
          setListening(false);
          setStarting(false);
          if (shouldRunRef.current) {
            window.setTimeout(() => {
              if (shouldRunRef.current && !volcActiveRef.current) {
                void startVolcWakeRef.current(sid);
              }
            }, RESTART_AFTER_ERROR_MS);
          }
        },
      });

      try {
        await session.buildAudioPipeline(stream, () => volcActiveRef.current);
      } catch {
        teardownVolcWake({ abortSocket: true });
        if (!isWakeStale(sessionId)) setWakeError('start-failed');
        setStarting(false);
        return;
      }
      if (bailIfStale()) return;

      setListening(true);
      setStarting(false);
      setWakeError(null);
    },
    [isWakeStale, teardownVolcWake],
  );

  startVolcWakeRef.current = startVolcWake;

  useEffect(() => {
    const sessionId = ++wakeSessionRef.current;
    const want =
      enabled && !paused && normalizeWakeText(effectivePhrase).length > 0;

    if (!want) {
      stopAll();
      setEngine('none');
      return () => stopAll();
    }

    const eng = pickEngine();
    setEngine(eng);
    if (eng === 'none') {
      stopAll();
      setWakeError('unsupported');
      return () => stopAll();
    }

    shouldRunRef.current = true;
    setWakeError(null);

    void (async () => {
      if (eng === 'volc') {
        stopWeb();
        try {
          await window.electron.volcAsrAbort();
        } catch {
          /* ignore */
        }
        teardownVolcWake({ abortSocket: false });
        if (isWakeStale(sessionId)) return;
        await startVolcWake(sessionId);
      } else {
        teardownVolcWake({ abortSocket: true });
        if (isWakeStale(sessionId)) return;
        if (!recRef.current) startWebLoopRef.current();
      }
    })();

    return () => {
      wakeSessionRef.current += 1;
      stopAll();
    };
  }, [
    enabled,
    paused,
    effectivePhrase,
    isWakeStale,
    pickEngine,
    startVolcWake,
    stopAll,
    stopWeb,
    teardownVolcWake,
  ]);

  const clearWakeError = useCallback(() => setWakeError(null), []);

  return {
    supported: engine !== 'none',
    listening,
    starting,
    wakeError,
    engine,
    lastWakeHeard,
    clearWakeError,
  };
}
