/**
 * 从 OpenAI 兼容 chat completions 流式 SSE 的 `data: {...}` 行中提取正文增量与推理/思维链增量。
 *
 * 兼容：
 * - DeepSeek：`delta.reasoning_content`
 * - 其它网关：`reasoning` / `thinking` / `thought` / `reasoningText` / `reasoning_summary`
 * - 内联 `<think>…</think>` 标签（DeepSeek-R1 蒸馏、部分 Qwen、第三方网关把思考塞进 content 的情况）
 */

type ChatDelta = {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  thinking?: string | null;
  thought?: string | null;
  reasoningText?: string | null;
  reasoning_summary?: string | null;
};

/** 单行 JSON chunk；非 data 或解析失败返回空二元组（无状态，不含内联标签处理） */
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
    const delta = j.choices?.[0]?.delta as (ChatDelta & Record<string, unknown>) | undefined;
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
        delta.reasoningText,
        delta.reasoning_summary,
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

/**
 * 有状态流式解析器：跨多个 SSE chunk 维持 `<think>…</think>` 内联标签状态。
 *
 * 很多模型（DeepSeek-R1 蒸馏、部分 Qwen、第三方网关）会把思考过程内联在 `content` 里，
 * 用 `<think>…</think>` 包裹。标签会跨多个 chunk 到达，因此需要维持状态：
 * - `inThink`：当前是否处于开闭标签之间
 * - `pendingTagMatch`：部分到达的标签前缀（如 `<th`），等下一个 chunk 补全再判断
 *
 * 用法：每个 stream session 实例化一次，逐行调用 `feed()`。
 */
export class StreamingDeltaSplitter {
  /** 是否正处在 <think> 与 </think> 之间 */
  private inThink = false;
  /** 上一行残留的未闭合标签前缀（如 "<th"），供下一行拼接判断 */
  private leftover = '';

  /**
   * 处理一行 SSE data，返回分流后的 { content, reasoning }。
   * 内联 think 标签包裹的文本会被路由到 reasoning，标签外的归 content。
   */
  feed(trimmedLine: string): { content: string; reasoning: string } {
    const { content: rawContent, reasoning } = extractContentAndReasoningFromSseDataLine(trimmedLine);
    /** reasoning 字段直接走思考通道，不受标签状态影响 */
    if (!rawContent) return { content: '', reasoning };
    /** 对 content 做 think 标签拆分 */
    const { content, reasoning: fromTag } = this.splitThinkTags(rawContent);
    return { content, reasoning: reasoning + fromTag };
  }

  /**
   * 核心：在一段文本中识别 <think...> 系列开标签与 </think...> 闭标签，
   * 把标签内文本归入 reasoning，标签外归 content。跨片状态由 this.inThink / leftover 维持。
   *
   * 匹配 think 开头的标签家族：think / thinking / thought，
   * 以及带后缀的变体（如 think_never_used_xxx 等 RLHF 内部标记）。
   *
   * 策略：用正则把完整文本切成「标签」和「普通文本」交替的 token 流，
   * 遍历 token，根据当前是否在 think 区决定归类。处理片尾可能的标签前缀残留。
   */
  private splitThinkTags(text: string): { content: string; reasoning: string } {
    /** 拼上上次残留的标签前缀 */
    const full = this.leftover + text;
    this.leftover = '';

    /**
     * 匹配开/闭 think 系列标签：
     * <think> <thinking> <thought> <think_never_used_xxx> </think> </think_xxx> 等。
     * think 后可跟 \w*（覆盖带后缀变体），再跟可选属性或 >。
     */
    const tagRe = /<\/?think\w*[^>]*>/gi;
    let contentOut = '';
    let reasoningOut = '';
    let lastIdx = 0;
    let match: RegExpExecArray | null;

    while ((match = tagRe.exec(full)) !== null) {
      /** 标签前的普通文本 */
      const between = full.slice(lastIdx, match.index);
      if (this.inThink) {
        reasoningOut += between;
      } else {
        contentOut += between;
      }
      /** 标签本身：判断是开还是闭 */
      const tag = match[0];
      if (/^<\//i.test(tag)) {
        this.inThink = false;
      } else {
        this.inThink = true;
      }
      lastIdx = match.index + tag.length;
    }

    /** 检查片尾是否有未完成的标签前缀（如 "<th"），留到下一片 */
    const tail = full.slice(lastIdx);
    const partialMatch = /<[^>]*$/.exec(tail);
    if (partialMatch) {
      /** 可能是 think 标签前缀：检查是否匹配候选 */
      const candidate = partialMatch[0];
      const afterLt = candidate.slice(1).toLowerCase();
      /** afterLt 是 "think" 或 "/think" 的前缀（如 "thi"、"/thi"），且不含 > 闭合符 */
      const stripped = afterLt.startsWith('/') ? afterLt.slice(1) : afterLt;
      const isPartialTag =
        !afterLt.includes('>') &&
        stripped.length < 'think'.length + 30 && // 合理上限，避免超长残片
        'think'.startsWith(stripped);
      if (isPartialTag) {
        /** 前缀前的文本归入当前区域，前缀本身留到下一片 */
        const beforePartial = tail.slice(0, partialMatch.index);
        if (this.inThink) {
          reasoningOut += beforePartial;
        } else {
          contentOut += beforePartial;
        }
        this.leftover = candidate;
        return { content: contentOut, reasoning: reasoningOut };
      }
    }

    /** 剩余文本按当前区域归类 */
    if (this.inThink) {
      reasoningOut += tail;
    } else {
      contentOut += tail;
    }
    return { content: contentOut, reasoning: reasoningOut };
  }

  /** 流结束时调用：清理残留状态（如未闭合的 think 标签） */
  flush(): void {
    this.inThink = false;
    this.leftover = '';
  }
}
