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

/** env 毫秒配置统一解析：读 env → parseInt → isFinite → clamp(min, max)；非法/缺省回 fallback */
function envDurationMs(name: string, min: number, max: number, fallback: number): number {
  const raw = process.env[name];
  if (raw !== undefined && String(raw).trim() !== '') {
    const n = parseInt(String(raw).trim(), 10);
    if (Number.isFinite(n)) return Math.min(Math.max(n, min), max);
  }
  return fallback;
}

/**
 * 本机 diffusers + `enable_model_cpu_offload` 等路径下，实测 512² / 4 步可超 10 分钟；
 * 默认 15 分钟；更大分辨率或首包下载请用环境变量调大。
 * @see MYAGENT_IMAGE_GEN_TIMEOUT_MS（毫秒，范围 60s–120min）
 * @see MYAGENT_IMAGE_GEN_FALLBACK_MS（Node 兜底 POST 单独限时，默认 min(主超时,3min)）
 */
export function resolveImageGenTimeoutMs(): number {
  return envDurationMs(
    'MYAGENT_IMAGE_GEN_TIMEOUT_MS',
    IMAGE_GEN_MIN_TIMEOUT_MS,
    IMAGE_GEN_MAX_TIMEOUT_MS,
    IMAGE_GEN_DEFAULT_TIMEOUT_MS
  );
}

export const IMAGE_GEN_TIMEOUT_MS = resolveImageGenTimeoutMs();

/**
 * 兜底 POST 单独限时：避免首包 fetch 与二次 Node 请求各占满主超时，体感「整应用卡死」。
 * @see MYAGENT_IMAGE_GEN_FALLBACK_MS（毫秒，不小于 30s、不超过主超时）
 */
export function resolveImageGenFallbackMs(mainMs: number): number {
  return envDurationMs(
    'MYAGENT_IMAGE_GEN_FALLBACK_MS',
    IMAGE_GEN_FALLBACK_MIN_MS,
    mainMs,
    Math.min(mainMs, IMAGE_GEN_FALLBACK_DEFAULT_MS)
  );
}

export const IMAGE_GEN_FALLBACK_MS = resolveImageGenFallbackMs(IMAGE_GEN_TIMEOUT_MS);

export function resolveOllamaEmptyProbeMs(): number {
  return envDurationMs(
    'MYAGENT_OLLAMA_EMPTY_PROBE_MS',
    5_000,
    IMAGE_GEN_TIMEOUT_MS,
    Math.min(IMAGE_GEN_TIMEOUT_MS, OLLAMA_EMPTY_PROBE_DEFAULT_MS)
  );
}

export const OLLAMA_EMPTY_PROBE_MS = resolveOllamaEmptyProbeMs();
