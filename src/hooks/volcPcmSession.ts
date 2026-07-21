import { float32MonoToPCM16Mono16k } from '@/utils/pcmDownsample';
import {
  addVolcPcmTapWorklet,
  VOLC_CHUNK_SAMPLES,
  VOLC_MAX_PENDING_SAMPLES,
  VOLC_PCM_TAP_PROCESSOR,
} from './useWebSpeechDictation/volcWorklet';

/**
 * 火山流式 ASR 的 PCM 采集会话：音频管线（AudioContext→Worklet→静音增益）、
 * PCM 分块队列推送、IPC 监听登记与清理、音频资源释放。
 * useVoiceWake（唤醒）与 useWebSpeechDictation/volcAsrPath（听写）共用；
 * 两侧仅文本处理策略不同，管线行为曾逐字复制且已轻微分化，故收敛。
 */
export type VolcPcmIpcHandlers = {
  onText: (text: string) => void;
  onError: (message: string) => void;
  onEnded: () => void;
};

export type VolcPcmSession = {
  /** 登记 volc-asr-text/error/ended 三通道监听，清理函数纳入 teardown 统一管理 */
  listenIpc: (handlers: VolcPcmIpcHandlers) => void;
  cleanupIpc: () => void;
  /**
   * 搭建音频管线；isActive 决定 worklet 回调是否吃 PCM（两 hook 各自的活跃判据）。
   * 任何一步失败抛错，调用方负责 teardown。
   */
  buildAudioPipeline: (stream: MediaStream, isActive: () => boolean) => Promise<void>;
  pushPcm: (pcm: Int16Array) => Promise<void>;
  /** 优雅收尾前推送不足一整块的尾包（主进程单次至少 64 样本） */
  flushRemainder: () => Promise<void>;
  /** 仅断开 tap/source（优雅收尾的第一步：停止吃新 PCM，但保留管线待 flush） */
  disconnectTap: () => void;
  releaseAudio: () => void;
  teardown: (opts: { abortSocket: boolean }) => void;
};

export function createVolcPcmSession(): VolcPcmSession {
  let audioCtx: AudioContext | null = null;
  let audioTap: AudioWorkletNode | null = null;
  let audioSource: MediaStreamAudioSourceNode | null = null;
  let mediaStream: MediaStream | null = null;
  let pendingPcm: number[] = [];
  let ipcCleanups: Array<() => void> = [];

  const cleanupIpc = (): void => {
    ipcCleanups.forEach((fn) => {
      try {
        fn();
      } catch {
        /* ignore */
      }
    });
    ipcCleanups = [];
  };

  const listenIpc = (handlers: VolcPcmIpcHandlers): void => {
    const offTxt = window.electron.onMessage('volc-asr-text', (...args: unknown[]) =>
      handlers.onText(String(args[0] ?? ''))
    );
    const offErr = window.electron.onMessage('volc-asr-error', (...args: unknown[]) =>
      handlers.onError(String(args[0] ?? ''))
    );
    const offEnd = window.electron.onMessage('volc-asr-ended', () => handlers.onEnded());
    ipcCleanups.push(offTxt, offErr, offEnd);
  };

  const disconnectTap = (): void => {
    try {
      audioTap?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      audioSource?.disconnect();
    } catch {
      /* ignore */
    }
    audioTap = null;
    audioSource = null;
  };

  const releaseAudio = (): void => {
    disconnectTap();
    const ctx = audioCtx;
    audioCtx = null;
    if (ctx?.state !== 'closed') {
      void ctx?.close().catch(() => {});
    }
    pendingPcm = [];
    mediaStream?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    });
    mediaStream = null;
  };

  const pushPcm = async (pcm: Int16Array): Promise<void> => {
    const pend = pendingPcm;
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
  };

  const flushRemainder = async (): Promise<void> => {
    const rest = pendingPcm;
    pendingPcm = [];
    if (rest.length >= 64) {
      try {
        await window.electron.volcAsrPushChunk(rest);
      } catch {
        /* ignore */
      }
    }
  };

  const buildAudioPipeline = async (stream: MediaStream, isActive: () => boolean): Promise<void> => {
    mediaStream = stream;
    pendingPcm = [];
    const ctx = new AudioContext();
    audioCtx = ctx;
    await ctx.resume().catch(() => {});
    await addVolcPcmTapWorklet(ctx);
    const tap = new AudioWorkletNode(ctx, VOLC_PCM_TAP_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelInterpretation: 'speakers',
      channelCountMode: 'explicit',
    });
    audioTap = tap;

    tap.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      if (!isActive()) return;
      const buf = ev.data;
      if (!buf || !(buf instanceof ArrayBuffer) || buf.byteLength < 4) return;
      const mono = new Float32Array(buf);
      const pcm = float32MonoToPCM16Mono16k(mono, ctx.sampleRate);
      if (pcm.length) void pushPcm(pcm);
    };

    const source = ctx.createMediaStreamSource(stream);
    audioSource = source;
    const silent = ctx.createGain();
    silent.gain.value = 0;
    source.connect(tap);
    tap.connect(silent);
    silent.connect(ctx.destination);
  };

  const teardown = (opts: { abortSocket: boolean }): void => {
    cleanupIpc();
    releaseAudio();
    if (opts.abortSocket) {
      try {
        void window.electron.volcAsrAbort();
      } catch {
        /* ignore */
      }
    }
  };

  return {
    listenIpc,
    cleanupIpc,
    buildAudioPipeline,
    pushPcm,
    flushRemainder,
    disconnectTap,
    releaseAudio,
    teardown,
  };
}
