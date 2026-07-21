/**
 * 图像生成子系统的限制常量。
 *
 * 与通用 timeouts/limits 分开，因为生图超时有自己的 env clamp 逻辑。
 */

/** CLI 子进程 stdout/stderr 合并日志最大长度 */
export const MAX_CLI_COMBINED_LOG_CHARS = 200_000;

/** 生图请求最小允许超时（毫秒），clamp 下限 */
export const IMAGE_GEN_MIN_TIMEOUT_MS = 60_000;

/** 生图请求最大允许超时（毫秒），clamp 上限 */
export const IMAGE_GEN_MAX_TIMEOUT_MS = 120 * 60 * 1000;

/** 生图默认超时（毫秒） */
export const IMAGE_GEN_DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/** 生图兜底 POST 单独最小超时（毫秒） */
export const IMAGE_GEN_FALLBACK_MIN_MS = 30_000;

/** 生图兜底 POST 默认超时（毫秒） */
export const IMAGE_GEN_FALLBACK_DEFAULT_MS = 3 * 60 * 1000;

/** Ollama empty body probe 默认超时（毫秒） */
export const OLLAMA_EMPTY_PROBE_DEFAULT_MS = 20_000;

/** 响应解析递归扫描最大深度 */
export const MAX_JSON_IMAGE_SCAN_DEPTH = 14;

/** JSON 字段名兜底提取时最长扫描字符数（base64 data URL 长度阈值） */
export const BASE64_MIN_LENGTH = 32;
/** 解码后二进制最小长度 */
export const BINARY_MIN_LENGTH = 64;
/** 兜底接收的最小二进长度 */
export const FALLBACK_BINARY_MIN_LENGTH = 320;

/**
 * 各生图后端单次请求图片数上限（超出部分由 image-gen.ts 串行循环补齐）。
 * 依据：百炼 wan2.6 文档单批 4；MiniMax image-01 n≤9；OpenAI Images n≤10；
 * SD WebUI batch_size 经验上限 8；CLI 单命令重复执行上限 12（防脚本侧失控）。
 */
export const VENDOR_IMAGE_COUNT_LIMITS = {
  bailianWanx: 4,
  minimax: 9,
  openAiImages: 10,
  sdWebUi: 8,
  cli: 12,
} as const;
