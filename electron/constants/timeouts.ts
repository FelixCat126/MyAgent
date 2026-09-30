/**
 * Electron 主进程 HTTP 请求超时（毫秒）。
 *
 * 与"最大字符数"等概念分开定义，避免同字面值不同语义混淆。
 */

/** 嵌入 API HTTP 超时（与阿里云百炼 embedding 等外部服务通信） */
export const EMBEDDING_HTTP_TIMEOUT_MS = 120_000;

/** 流式聊天请求总超时（含长上下文、超大输出场景） */
export const MODEL_STREAM_TIMEOUT_MS = 300_000;

/** 流式请求建立后等待首个 SSE 事件的上限 */
export const MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS = 30_000;

/** 流式连接无任何网络活动时的上限；持续产出内容时不会触发 */
export const MODEL_STREAM_IDLE_TIMEOUT_MS = 45_000;

/** 非流式聊天请求默认超时 */
export const MODEL_HTTP_TIMEOUT_MS = 120_000;

/** 配置页连通性测试：快速给出明确结果，避免测试按钮长时间悬挂 */
export const MODEL_CONNECTION_TEST_TIMEOUT_MS = 20_000;

/** Claude 同步调用超时 */
export const CLAUDE_HTTP_TIMEOUT_MS = 60_000;

/** Gemini 同步调用超时 */
export const GEMINI_HTTP_TIMEOUT_MS = 60_000;
