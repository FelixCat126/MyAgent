/**
 * Electron 主进程 HTTP 请求超时（毫秒）。
 *
 * 与"最大字符数"等概念分开定义，避免同字面值不同语义混淆。
 */

/** 嵌入 API HTTP 超时（与阿里云百炼 embedding 等外部服务通信） */
export const EMBEDDING_HTTP_TIMEOUT_MS = 120_000;

/** 流式聊天请求总超时（含长上下文、超大输出场景） */
export const MODEL_STREAM_TIMEOUT_MS = 300_000;

/** 非流式聊天请求默认超时 */
export const MODEL_HTTP_TIMEOUT_MS = 120_000;

/** Claude 同步调用超时 */
export const CLAUDE_HTTP_TIMEOUT_MS = 60_000;

/** Gemini 同步调用超时 */
export const GEMINI_HTTP_TIMEOUT_MS = 60_000;
