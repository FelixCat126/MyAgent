import type { Locale } from '../i18n/types';
import type { Message, ModelConfig } from '../types';
import { canUseSseStream } from '../utils/chatModelPolicy';
import {
  createAgentCancelledError,
} from './browser/agentBrowserController';

export type AgentModelRoundHandlers = {
  onDelta?: (chunk: string) => void;
  onThinkingDelta?: (chunk: string) => void;
  shouldCancel?: () => boolean;
};

export type AgentModelRoundResult = {
  content: string;
  reasoning?: string;
};

/** Agent 单轮调用强制低温，提高工具调用与摘录序列的确定性；与主聊天分离 */
const AGENT_TEMPERATURE = 0.2;

function throwIfCancelled(shouldCancel?: () => boolean): void {
  if (shouldCancel?.()) throw createAgentCancelledError();
}

/** Agent 单轮模型调用：优先 SSE 以收集 reasoning，与主聊天流式思考展示一致 */
export async function callModelAgentRound(
  messages: Message[],
  model: ModelConfig,
  locale: Locale,
  handlers?: AgentModelRoundHandlers
): Promise<AgentModelRoundResult> {
  throwIfCancelled(handlers?.shouldCancel);

  if (canUseSseStream(model)) {
    return new Promise((resolve, reject) => {
      let content = '';
      let reasoning = '';
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        window.clearInterval(poll);
        fn();
      };
      const unsub = window.electron.subscribeModelStream(messages, model, {
        locale,
        temperature: AGENT_TEMPERATURE,
        onDelta: (t) => {
          if (handlers?.shouldCancel?.()) {
            finish(() => {
              try {
                window.electron.closeModelStream();
              } catch {
                /* ignore */
              }
              unsub();
              reject(createAgentCancelledError());
            });
            return;
          }
          content += t;
          if (t) handlers?.onDelta?.(t);
        },
        onThinkingDelta: (t) => {
          if (handlers?.shouldCancel?.()) return;
          reasoning += t;
          if (t) handlers?.onThinkingDelta?.(t);
        },
        onEnd: () => {
          finish(() => {
            unsub();
            if (handlers?.shouldCancel?.()) {
              reject(createAgentCancelledError());
              return;
            }
            resolve({
              content: content.trim(),
              ...(reasoning.trim() ? { reasoning: reasoning.trim() } : {}),
            });
          });
        },
        onError: (m) => {
          finish(() => {
            unsub();
            reject(new Error(m));
          });
        },
      });
      const poll = window.setInterval(() => {
        if (!handlers?.shouldCancel?.()) return;
        finish(() => {
          try {
            window.electron.closeModelStream();
          } catch {
            /* ignore */
          }
          unsub();
          reject(createAgentCancelledError());
        });
      }, 120);
    });
  }

  throwIfCancelled(handlers?.shouldCancel);
  const response = await window.electron.callModel(messages, model, {
    locale,
    temperature: AGENT_TEMPERATURE,
  });
  throwIfCancelled(handlers?.shouldCancel);
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
