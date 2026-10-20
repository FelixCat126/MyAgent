import { completionWasTruncated } from '../../src/utils/completionStatus';
import { ipcMain, WebContents } from 'electron';
import axios, { type AxiosError } from 'axios';
import { ModelConfig, Message } from '../../src/types';
import { mapModelCallError } from '../../src/utils/modelErrors';
import {
  buildAnthropicAuthHeaders,
  buildAnthropicThinkingParams,
  looksLikeMiniMaxChat,
  resolveAnthropicMessagesUrl,
  resolveChatApiMode,
} from '../../src/utils/chatApiMode';
import {
  errorIndicatesImageUnsupported,
  formatAnthropicMessages,
  formatOpenAIMultimodal,
  formatOpenAITextOnly,
  isZhipuEndpoint,
  messagesHaveImageFiles,
  resolveOpenAiCompatibleBaseUrl,
  buildThinkingParams,
} from './openai-adapters';
import {
  canFallbackAnthropicToOpenAi,
  withAnthropicThinkingFallback,
  withOpenAiCompatibleFallbacks,
} from './openai-chat-retry';
import { StreamingDeltaSplitter } from '../utils/streamChatCompletionDelta';
import { consumeSseLines } from '../utils/sseStreamCompletion';
import {
  MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS,
  MODEL_STREAM_IDLE_TIMEOUT_MS,
  MODEL_STREAM_TIMEOUT_MS,
} from '../constants/timeouts';

/** 键为 `${webContents.id}:${streamId}`；未带 streamId 的旧调用方共用 `legacy` 槽位，新流会顶替旧流 */
const abortByStream = new Map<string, AbortController>();
const LEGACY_STREAM_ID = 'legacy';

/** 事件末尾附带 streamId，渲染端据此把同一窗口内的多条并行流分开 */
type StreamTarget = { wc: WebContents; streamId: string };

function sendDelta(out: StreamTarget, text: string) {
  if (!text) return;
  out.wc.send('model-stream-delta', text, out.streamId);
}

function sendThinkingDelta(out: StreamTarget, text: string) {
  if (!text) return;
  out.wc.send('model-stream-thinking-delta', text, out.streamId);
}

function sendEnd(out: StreamTarget) {
  out.wc.send('model-stream-end', out.streamId);
}

function sendErr(out: StreamTarget, message: string) {
  out.wc.send('model-stream-error', message, out.streamId);
}

/** 文档输出已报截断：渲染端随即结束订阅，主进程也须停止读流 */
class DocumentLimitReached extends Error {}

function reportDocumentLimit(out: StreamTarget, messages: Message[], raw: string) {
  if (!messages.some(m => m.role === 'system' && m.model === 'myagent-document-export')) return;
  let truncated = false;
  try {
    truncated = completionWasTruncated(JSON.parse(raw));
  } catch { /* Ignore non-JSON SSE markers. */ }
  if (!truncated) return;
  sendErr(out, '模型达到输出长度上限，正文尚未完整生成。已保留部分内容；请增加模型输出长度或分章节生成后重试。');
  throw new DocumentLimitReached();
}

/** 长文/推理模型可能持续输出超过 5 分钟；总时长放宽，卡死由空闲超时兜底 */
const STREAM_MAX_DURATION_MS = Math.max(MODEL_STREAM_TIMEOUT_MS, 15 * 60_000);

/** 首包之后若连续无数据，主动销毁流，让 consumeSseLines 以超时错误结束 */
function watchStreamIdle(stream: { on: (ev: 'data', fn: () => void) => void; destroy?: (err?: Error) => void }): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const arm = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const error = new Error('MODEL_STREAM_IDLE_TIMEOUT') as Error & { code?: string };
      error.code = 'ETIMEDOUT';
      stream.destroy?.(error);
    }, MODEL_STREAM_IDLE_TIMEOUT_MS);
  };
  stream.on('data', arm);
  arm();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** 通用 Anthropic Messages 流式（Claude / MiniMax / 兼容网关） */
async function streamAnthropicMessages(opts: {
  wc: StreamTarget;
  ac: AbortController;
  config: ModelConfig;
  temperature: number | undefined;
  messages: Message[];
}): Promise<void> {
  const { wc, ac, config, temperature, messages } = opts;
  const { apiUrl, apiKey, modelName, maxTokens, provider } = config;
  const url = resolveAnthropicMessagesUrl(apiUrl);
  const isMiniMax = looksLikeMiniMaxChat(apiUrl, modelName);
  const { system, messages: anthropicMessages } = formatAnthropicMessages(messages, {
    includeAssistantThinking: isMiniMax,
  });
  const headers = buildAnthropicAuthHeaders({ apiKey, provider, apiUrl });
  const thinking = buildAnthropicThinkingParams({
    apiUrl,
    modelName,
    provider,
    maxTokens,
  });

  const postStream = (thinkingParams: { thinking?: Record<string, unknown> }) => {
    const body: Record<string, unknown> = {
      model: modelName,
      max_tokens: Math.max(1, maxTokens || 4096),
      stream: true,
      ...thinkingParams,
      messages: anthropicMessages,
      ...(system ? { system } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
    };
    return axios.post(url, body, {
      headers,
      responseType: 'stream',
      timeout: MODEL_STREAM_IDLE_TIMEOUT_MS,
      signal: ac.signal,
      validateStatus: (s) => s >= 200 && s < 300,
    });
  };

  const response = await withAnthropicThinkingFallback({
    thinkingParams: thinking,
    request: postStream,
    onFallback: () => {
      if (process.env.MYAGENT_DEBUG) {
        console.warn('[model-stream] Anthropic 思考参数被拒绝，已改为标准 Messages 请求重试', {
          modelName,
        });
      }
    },
  });

  const stream = response.data as NodeJS.ReadableStream & {
    on: (ev: 'data' | 'end' | 'error', fn: (x?: string | Buffer | Error) => void) => void;
  };

  const handleSseLine = (line: string) => {
    const trimmed = line.replace(/\r$/, '').trim();
    if (!trimmed.startsWith('data:')) return;
    const raw = trimmed.slice(5).trim();
    if (!raw || raw === '[DONE]') return;
    let j: {
      type?: string;
      delta?: { type?: string; thinking?: string; text?: string };
    };
    try {
      j = JSON.parse(raw) as typeof j;
    } catch {
      return;
    }
    reportDocumentLimit(wc, messages, raw);
    if (j.type !== 'content_block_delta' || !j.delta) return;
    const dt = j.delta.type;
    if (dt === 'thinking_delta' && typeof j.delta.thinking === 'string' && j.delta.thinking) {
      sendThinkingDelta(wc, j.delta.thinking);
    } else if (dt === 'text_delta' && typeof j.delta.text === 'string' && j.delta.text) {
      sendDelta(wc, j.delta.text);
    }
  };

  const stopIdleWatch = watchStreamIdle(stream);
  try {
    await consumeSseLines(stream, handleSseLine, {
      firstEventTimeoutMs: MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS,
      maxDurationMs: STREAM_MAX_DURATION_MS,
    });
  } finally {
    stopIdleWatch();
  }
}

async function streamOpenAiCompatible(opts: {
  wc: StreamTarget;
  ac: AbortController;
  config: ModelConfig;
  temperature: number | undefined;
  messages: Message[];
}): Promise<void> {
  const { wc, ac, config, temperature, messages } = opts;
  const { provider, apiUrl, apiKey, modelName, maxTokens } = config;
  const apiBase = resolveOpenAiCompatibleBaseUrl(apiUrl, provider);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let formattedMultimodal = formatOpenAIMultimodal(messages) as Array<{
    role: string;
    content: unknown;
  }>;
  const formattedText = formatOpenAITextOnly(messages) as Array<{
    role: string;
    content: unknown;
  }>;
  const thinkingParams = buildThinkingParams({ apiUrl, modelName, stream: true });

  const doStream = async (
    msgs: Array<{ role: string; content: unknown }>,
    withThinking = true
  ) => {
    const body: Record<string, unknown> = {
      model: modelName,
      messages: msgs,
      max_tokens: maxTokens,
      stream: true,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(withThinking ? thinkingParams : {}),
    };
    return axios.post(`${apiBase}/chat/completions`, body, {
      headers,
      responseType: 'stream',
      timeout: MODEL_STREAM_IDLE_TIMEOUT_MS,
      signal: ac.signal,
      validateStatus: (s) => s >= 200 && s < 300,
    });
  };

  const response = await withOpenAiCompatibleFallbacks({
    messages,
    messagesHaveImages: messagesHaveImageFiles(messages),
    errorIndicatesImageUnsupported,
    request: (mode, withThinking) =>
      doStream(mode === 'multimodal' ? formattedMultimodal : formattedText, withThinking),
    onImageFallback: () => {
      formattedMultimodal = formattedText;
    },
    onThinkingFallback: () => {
      if (process.env.MYAGENT_DEBUG) {
        console.warn('[model-stream] 思考参数 400，降级为无思考参数重试', { modelName });
      }
    },
  });

  const stream = response.data as NodeJS.ReadableStream & {
    on: (ev: 'data' | 'end' | 'error', fn: (x?: string | Buffer | Error) => void) => void;
  };

  const splitter = new StreamingDeltaSplitter();
  const stopIdleWatch = watchStreamIdle(stream);
  try {
    await consumeSseLines(stream, (line) => {
      const trimmed = line.trim();
      const { content, reasoning } = splitter.feed(trimmed);
      sendDelta(wc, content);
      sendThinkingDelta(wc, reasoning);
      if (trimmed.startsWith('data:')) {
        reportDocumentLimit(wc, messages, trimmed.slice(5).trim());
      }
    }, { firstEventTimeoutMs: MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS, maxDurationMs: STREAM_MAX_DURATION_MS });
  } finally {
    stopIdleWatch();
  }
  splitter.flush();
}

function registerModelStreamIpc() {
  ipcMain.on(
    'model-stream-start',
    (
      event,
      payload: {
        messages: Message[];
        config: ModelConfig;
        locale?: 'zh' | 'en';
        temperature?: number;
        streamId?: string;
      }
    ) => {
      const { messages, config, locale: loc, temperature: tRaw } = payload;
      const locale = loc === 'en' ? 'en' : 'zh';
      const temperature =
        typeof tRaw === 'number' && Number.isFinite(tRaw)
          ? Math.max(0, Math.min(2, tRaw))
          : undefined;
      const sender = event.sender;
      const streamId =
        typeof payload.streamId === 'string' && payload.streamId && payload.streamId.length <= 160
          ? payload.streamId
          : LEGACY_STREAM_ID;
      const wc: StreamTarget = { wc: sender, streamId };
      const sid = `${typeof sender.id === 'number' ? sender.id : 0}:${streamId}`;
      const prev = abortByStream.get(sid);
      prev?.abort();
      const ac = new AbortController();
      abortByStream.set(sid, ac);

      void (async () => {
        try {
          const { provider } = config;
          const isZhipu = isZhipuEndpoint(config.apiUrl, config.modelName);
          const apiMode = resolveChatApiMode(config);

          /** Claude 提供商或显式/自动 Anthropic 模式 → Messages API */
          if (provider === 'claude' || apiMode === 'anthropic') {
            try {
              await streamAnthropicMessages({ wc, ac, config, temperature, messages });
              sendEnd(wc);
              return;
            } catch (anthropicErr: unknown) {
              const status = (anthropicErr as AxiosError)?.response?.status;
              if (anthropicErr instanceof DocumentLimitReached || !canFallbackAnthropicToOpenAi(config)) throw anthropicErr;
              if (process.env.MYAGENT_DEBUG) {
                console.warn('[model-stream] Anthropic 失败，回退 OpenAI 兼容', {
                  status,
                  /** 脱敏：截断消息并仅保留错误类型，避免远端 URL/响应内容泄漏 */
                  messagePrefix:
                    anthropicErr instanceof Error
                      ? anthropicErr.message.slice(0, 200)
                      : String(anthropicErr).slice(0, 200),
                });
              }
            }
          }

          if (provider !== 'openai' && provider !== 'custom' && provider !== 'ollama' && !isZhipu) {
            sendErr(
              wc,
              provider === 'gemini'
                ? 'Gemini 暂不支持流式输出，请关闭「流式输出」后重试，或改用 OpenAI 兼容 / Ollama / 智谱。'
                : '当前提供商不支持流式输出，请使用 OpenAI/兼容 或 Ollama，或关闭流式。'
            );
            sendEnd(wc);
            return;
          }

          await streamOpenAiCompatible({ wc, ac, config, temperature, messages });
          sendEnd(wc);
        } catch (e) {
          const ax = e as AxiosError;
          if (e instanceof DocumentLimitReached || ax?.name === 'CanceledError' || ac.signal.aborted) {
            sendEnd(wc);
          } else {
            sendErr(wc, mapModelCallError(e, locale));
            sendEnd(wc);
          }
        } finally {
          if (abortByStream.get(sid) === ac) abortByStream.delete(sid);
        }
      })();
    }
  );

  /** 带 streamId 只中止该流；不带则中止本窗口全部流（窗口卸载、旧调用方） */
  ipcMain.on('model-stream-abort', (event, streamId?: unknown) => {
    const prefix = `${event.sender.id}:`;
    if (typeof streamId === 'string' && streamId) {
      abortByStream.get(prefix + streamId)?.abort();
      return;
    }
    for (const [key, controller] of abortByStream) {
      if (key.startsWith(prefix)) controller.abort();
    }
  });
}

registerModelStreamIpc();
