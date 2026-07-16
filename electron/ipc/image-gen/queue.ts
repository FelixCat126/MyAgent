import {
  IMAGE_GEN_MIN_TIMEOUT_MS,
  IMAGE_GEN_MAX_TIMEOUT_MS,
  IMAGE_GEN_DEFAULT_TIMEOUT_MS,
  IMAGE_GEN_FALLBACK_MIN_MS,
  IMAGE_GEN_FALLBACK_DEFAULT_MS,
  OLLAMA_EMPTY_PROBE_DEFAULT_MS,
} from '../../constants';

/** 全应用单次只跑一个生图 IPC，避免多张并行 CLI/HTTP 抢占 GPU 或卡住主线程 */
let imageGenerationQueueTail: Promise<void> = Promise.resolve();

export function enqueueSerializedImageGeneration<T>(job: () => Promise<T>): Promise<T> {
  const run = imageGenerationQueueTail.then(job);
  imageGenerationQueueTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * 本机 diffusers + `enable_model_cpu_offload` 等路径下，实测 512² / 4 步可超 10 分钟；
 * 默认 15 分钟；更大分辨率或首包下载请用环境变量调大。
 * @see MYAGENT_IMAGE_GEN_TIMEOUT_MS（毫秒，范围 60s–120min）
 * @see MYAGENT_IMAGE_GEN_FALLBACK_MS（Node 兜底 POST 单独限时，默认 min(主超时,3min)）
 */
export function resolveImageGenTimeoutMs(): number {
  const raw = process.env.MYAGENT_IMAGE_GEN_TIMEOUT_MS;
  if (raw !== undefined && String(raw).trim() !== '') {
    const n = parseInt(String(raw).trim(), 10);
    if (Number.isFinite(n)) {
      const clamped = Math.min(Math.max(n, IMAGE_GEN_MIN_TIMEOUT_MS), IMAGE_GEN_MAX_TIMEOUT_MS);
      return clamped;
    }
  }
  return IMAGE_GEN_DEFAULT_TIMEOUT_MS;
}

export const IMAGE_GEN_TIMEOUT_MS = resolveImageGenTimeoutMs();

/**
 * 兜底 POST 单独限时：避免首包 fetch 与二次 Node 请求各占满主超时，体感「整应用卡死」。
 * @see MYAGENT_IMAGE_GEN_FALLBACK_MS（毫秒，不小于 30s、不超过主超时）
 */
export function resolveImageGenFallbackMs(mainMs: number): number {
  const raw = process.env.MYAGENT_IMAGE_GEN_FALLBACK_MS;
  if (raw !== undefined && String(raw).trim() !== '') {
    const n = parseInt(String(raw).trim(), 10);
    if (Number.isFinite(n)) {
      return Math.min(Math.max(n, IMAGE_GEN_FALLBACK_MIN_MS), mainMs);
    }
  }
  return Math.min(mainMs, IMAGE_GEN_FALLBACK_DEFAULT_MS);
}

export const IMAGE_GEN_FALLBACK_MS = resolveImageGenFallbackMs(IMAGE_GEN_TIMEOUT_MS);

export function resolveOllamaEmptyProbeMs(): number {
  const raw = process.env.MYAGENT_OLLAMA_EMPTY_PROBE_MS;
  if (raw !== undefined && String(raw).trim() !== '') {
    const n = parseInt(String(raw).trim(), 10);
    if (Number.isFinite(n)) return Math.min(Math.max(n, 5_000), IMAGE_GEN_TIMEOUT_MS);
  }
  return Math.min(IMAGE_GEN_TIMEOUT_MS, OLLAMA_EMPTY_PROBE_DEFAULT_MS);
}

export const OLLAMA_EMPTY_PROBE_MS = resolveOllamaEmptyProbeMs();
