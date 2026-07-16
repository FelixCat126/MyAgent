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
