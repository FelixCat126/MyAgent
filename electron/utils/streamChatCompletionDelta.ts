/**
 * 从 OpenAI 兼容 chat completions 流式 SSE 的 `data: {...}` 行中提取正文增量与推理/思维链增量。
 *
 * 兼容：
 * - DeepSeek：`delta.reasoning_content`
 * - MiniMax（reasoning_split）：`delta.reasoning_details[].text`（官方为**累计全文**，需差分）
 * - 其它网关：`reasoning` / `thinking` / `thought` / `reasoningText` / `reasoning_summary`
 * - 内联 `<think>…</think>` 标签（未 split 时 MiniMax / DeepSeek-R1 等）
 */

type ChatDelta = {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  thinking?: string | null;
  thought?: string | null;
  reasoningText?: string | null;
  reasoning_summary?: string | null;
  reasoning_details?: unknown;
};

/** 从 reasoning_details（字符串 / 对象 / 数组）取出 text 列表 */
export function collectReasoningDetailTexts(rd: unknown): string[] {
  if (rd == null) return [];
  if (typeof rd === 'string') return rd ? [rd] : [];
  if (Array.isArray(rd)) {
    return rd
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
          return (item as { text: string }).text;
        }
        return '';
      })
      .filter(Boolean);
  }
  if (typeof rd === 'object' && typeof (rd as { text?: unknown }).text === 'string') {
    return [(rd as { text: string }).text];
  }
  return [];
}

/**
 * MiniMax 官方流式示例：`reasoning_details[].text`（及部分网关的 reasoning_content）为累计全文。
 * 对「若 next 以 prev 为前缀则取后缀，否则当增量拼接」做统一处理。
 */
export function takeCumulativeOrIncremental(prev: string, next: string): {
  emit: string;
  nextPrev: string;
} {
  if (!next) return { emit: '', nextPrev: prev };
  if (prev && next.startsWith(prev)) {
    return { emit: next.slice(prev.length), nextPrev: next };
  }
  return { emit: next, nextPrev: prev + next };
}

/** 单行 JSON chunk；非 data 或解析失败返回空（无状态；不含累计差分 / think 标签） */
export function extractContentAndReasoningFromSseDataLine(trimmedLine: string): {
  content: string;
  reasoning: string;
  /** 原始 reasoning_details 文本（可能为累计全文，供有状态解析器差分） */
  reasoningDetailsTexts: string[];
  /** 结构化 reasoning_* 字符串字段原始值（可能为累计或增量） */
  reasoningFieldRaw: string;
} {
  const empty = { content: '', reasoning: '', reasoningDetailsTexts: [] as string[], reasoningFieldRaw: '' };
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
    const reasoningFieldRaw =
      (delta &&
        ([
          delta.reasoning_content,
          delta.reasoning,
          delta.thinking,
          delta.thought,
          delta.reasoningText,
          delta.reasoning_summary,
        ].find((x) => typeof x === 'string') as string | undefined)) ||
      '';
    const reasoningDetailsTexts = delta ? collectReasoningDetailTexts(delta.reasoning_details) : [];
    /** 无状态默认：details 优先（MiniMax split），否则字符串字段；调用方若做累计差分应读 raw 字段 */
    const reasoning =
      reasoningDetailsTexts.length > 0 ? reasoningDetailsTexts.join('') : reasoningFieldRaw;
    return {
      content: typeof content === 'string' ? content : '',
      reasoning,
      reasoningDetailsTexts,
      reasoningFieldRaw,
    };
  } catch {
    return empty;
  }
}

/**
 * 有状态流式解析器：
 * 1) MiniMax reasoning_split：对 reasoning_details / reasoning_content 做累计差分
 * 2) 内联 `<think>…</think>`：跨 chunk 拆到 reasoning
 */
export class StreamingDeltaSplitter {
  /** 是否正处在 <think> 与 </think> 之间 */
  private inThink = false;
  /** 上一行残留的未闭合标签前缀（如 "<th"），供下一行拼接判断 */
  private leftover = '';
  /** MiniMax reasoning_details[].text 累计缓冲（官方 SDK 示例同款差分） */
  private reasoningDetailsAccum = '';
  /** reasoning_content 等字符串字段累计缓冲 */
  private reasoningFieldAccum = '';

  /**
   * 处理一行 SSE data，返回分流后的 { content, reasoning }（均为应对 UI 的增量）。
   */
  feed(trimmedLine: string): { content: string; reasoning: string } {
    const parsed = extractContentAndReasoningFromSseDataLine(trimmedLine);
    let reasoningOut = '';

    /** 1) reasoning_details：按官方示例对每段 text 做累计差分 */
    if (parsed.reasoningDetailsTexts.length > 0) {
      for (const text of parsed.reasoningDetailsTexts) {
        const { emit, nextPrev } = takeCumulativeOrIncremental(this.reasoningDetailsAccum, text);
        this.reasoningDetailsAccum = nextPrev;
        reasoningOut += emit;
      }
    } else if (parsed.reasoningFieldRaw) {
      /** 2) 无 details 时：reasoning_content 等也可能是累计全文 */
      const { emit, nextPrev } = takeCumulativeOrIncremental(
        this.reasoningFieldAccum,
        parsed.reasoningFieldRaw
      );
      this.reasoningFieldAccum = nextPrev;
      reasoningOut += emit;
    }

    const rawContent = parsed.content;
    if (!rawContent) return { content: '', reasoning: reasoningOut };

    /** 3) content 内 <think> 标签拆分（未开 split 时的兜底） */
    const { content, reasoning: fromTag } = this.splitThinkTags(rawContent);
    return { content, reasoning: reasoningOut + fromTag };
  }

  /**
   * 核心：在一段文本中识别 <think...> 系列开标签与 </think...> 闭标签，
   * 把标签内文本归入 reasoning，标签外归 content。跨片状态由 this.inThink / leftover 维持。
   */
  private splitThinkTags(text: string): { content: string; reasoning: string } {
    const full = this.leftover + text;
    this.leftover = '';

    const tagRe = /<\/?think\w*[^>]*>/gi;
    let contentOut = '';
    let reasoningOut = '';
    let lastIdx = 0;
    let match: RegExpExecArray | null;

    while ((match = tagRe.exec(full)) !== null) {
      const between = full.slice(lastIdx, match.index);
      if (this.inThink) {
        reasoningOut += between;
      } else {
        contentOut += between;
      }
      const tag = match[0];
      if (/^<\//i.test(tag)) {
        this.inThink = false;
      } else {
        this.inThink = true;
      }
      lastIdx = match.index + tag.length;
    }

    const tail = full.slice(lastIdx);
    const partialMatch = /<[^>]*$/.exec(tail);
    if (partialMatch) {
      const candidate = partialMatch[0];
      const afterLt = candidate.slice(1).toLowerCase();
      const stripped = afterLt.startsWith('/') ? afterLt.slice(1) : afterLt;
      const isPartialTag =
        !afterLt.includes('>') &&
        stripped.length < 'think'.length + 30 &&
        'think'.startsWith(stripped);
      if (isPartialTag) {
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

    if (this.inThink) {
      reasoningOut += tail;
    } else {
      contentOut += tail;
    }
    return { content: contentOut, reasoning: reasoningOut };
  }

  flush(): void {
    this.inThink = false;
    this.leftover = '';
  }
}
