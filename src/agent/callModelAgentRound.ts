import type { Locale } from '../i18n/types';
import type { Message, ModelConfig } from '../types';
import { canUseSseStream } from '../utils/chatModelPolicy';

export type AgentModelRoundHandlers = {
  onDelta?: (chunk: string) => void;
  onThinkingDelta?: (chunk: string) => void;
};

export type AgentModelRoundResult = {
  content: string;
  reasoning?: string;
};

/** Agent 单轮调用强制低温，提高工具调用与摘录序列的确定性；与主聊天分离 */
const AGENT_TEMPERATURE = 0.2;

/** Agent 单轮模型调用：优先 SSE 以收集 reasoning，与主聊天流式思考展示一致 */
export async function callModelAgentRound(
  messages: Message[],
  model: ModelConfig,
  locale: Locale,
  handlers?: AgentModelRoundHandlers
): Promise<AgentModelRoundResult> {
  if (canUseSseStream(model)) {
    return new Promise((resolve, reject) => {
      let content = '';
      let reasoning = '';
      const unsub = window.electron.subscribeModelStream(messages, model, {
        locale,
        temperature: AGENT_TEMPERATURE,
        onDelta: (t) => {
          content += t;
          if (t) handlers?.onDelta?.(t);
        },
        onThinkingDelta: (t) => {
          reasoning += t;
          if (t) handlers?.onThinkingDelta?.(t);
        },
        onEnd: () => {
          unsub();
          resolve({
            content: content.trim(),
            ...(reasoning.trim() ? { reasoning: reasoning.trim() } : {}),
          });
        },
        onError: (m) => {
          unsub();
          reject(new Error(m));
        },
      });
    });
  }

  const response = await window.electron.callModel(messages, model, {
    locale,
    temperature: AGENT_TEMPERATURE,
  });
  const content = String(response.content ?? '').trim();
  const reasoningIn =
    typeof (response as { reasoning?: unknown }).reasoning === 'string'
      ? String((response as { reasoning?: string }).reasoning).trim()
      : '';
  return {
    content,
    ...(reasoningIn ? { reasoning: reasoningIn } : {}),
  };
}
