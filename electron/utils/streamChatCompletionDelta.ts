/**
 * 从 OpenAI 兼容 chat completions 流式 SSE 的 `data: {...}` 行中提取正文增量与推理/思维链增量。
 * 兼容 DeepSeek：`delta.reasoning_content`；及其它网关：`reasoning` / `thinking` 字符串字段。
 */

type ChatDelta = {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  thinking?: string | null;
};

/** 单行 JSON chunk；非 data 或解析失败返回空二元组 */
export function extractContentAndReasoningFromSseDataLine(trimmedLine: string): {
  content: string;
  reasoning: string;
} {
  const empty = { content: '', reasoning: '' };
  if (!trimmedLine.startsWith('data:')) return empty;
  const data = trimmedLine.slice(5).trim();
  if (data === '' || data === '[DONE]') return empty;
  try {
    const j = JSON.parse(data) as {
      message?: { content?: unknown; reasoning_content?: unknown };
      choices?: Array<{ delta?: ChatDelta & Record<string, unknown> }>;
    };
    const delta = j.choices?.[0]?.delta;
    let content = '';
    if (typeof delta?.content === 'string') {
      content = delta.content;
    } else if (typeof j.message?.content === 'string') {
      content = j.message.content;
    }
    let reasoning = '';
    const r =
      delta &&
      ([
        delta.reasoning_content,
        delta.reasoning,
        delta.thinking,
        delta.thought,
        (delta as Record<string, unknown>).reasoningText,
      ].find((x) => typeof x === 'string') as string | undefined);
    if (typeof r === 'string') reasoning = r;
    return {
      content: typeof content === 'string' ? content : '',
      reasoning,
    };
  } catch {
    return empty;
  }
}
