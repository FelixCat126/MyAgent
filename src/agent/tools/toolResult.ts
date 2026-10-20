/** 单条工具结果写回模型上下文的上限，避免原生工具结果撑爆上下文 */
export const MAX_TOOL_RESULT_CHARS = 12_000;

export function truncateToolResult(text: string, max = MAX_TOOL_RESULT_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n\n（工具结果已截断，以上为前部内容）` : text;
}

export function isToolErrorText(text: string): boolean {
  return /(?:^|\n|】)\s*错误：/.test(text);
}

/** 与原生 tool call 一一对应的单条结果 */
export type AgentToolCallOutcome = { text: string; isError: boolean };
