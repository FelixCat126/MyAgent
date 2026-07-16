/**
 * 文本/数据规模限制（字符数）。
 *
 * 与 HTTP 超时分开放，避免 120_000 这种字面值跨概念误用。
 */

/** 文档文本提取最大字符数 */
export const DOCUMENT_MAX_CHARS = 120_000;

/** Agent 本地文件读取最大字符数 */
export const AGENT_LOCAL_MAX_READ_CHARS = 120_000;
