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
} from '../constants/timeouts';

const abortByStream = new Map<number, AbortController>();

function sendDelta(wc: WebContents, text: string) {
  if (!text) return;
  wc.send('model-stream-delta', text);
}

function sendThinkingDelta(wc: WebContents, text: string) {
  if (!text) return;
  wc.send('model-stream-thinking-delta', text);
}

function sendEnd(wc: WebContents) {
  wc.send('model-stream-end');
}

function sendErr(wc: WebContents, message: string) {
  wc.send('model-stream-error', message);
}

function reportDocumentLimit(wc: WebContents, messages: Message[], raw: string) {
  if (!messages.some(m => m.role === 'system' && m.model === 'myagent-document-export')) return;
  try {
    if (completionWasTruncated(JSON.parse(raw))) sendErr(wc, '模型达到输出长度上限，正文尚未完整生成。已保留部分内容；请增加模型输出长度或分章节生成后重试。');
  } catch { /* Ignore non-JSON SSE markers. */ }
}

/** 通用 Anthropic Messages 流式（Claude / MiniMax / 兼容网关） */
async function streamAnthropicMessages(opts: {
  wc: WebContents;
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

  await consumeSseLines(stream, handleSseLine, {
    firstEventTimeoutMs: MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS,
  });
}

async function streamOpenAiCompatible(opts: {
  wc: WebContents;
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
  await consumeSseLines(stream, (line) => {
    const trimmed = line.trim();
    const { content, reasoning } = splitter.feed(trimmed);
    sendDelta(wc, content);
    sendThinkingDelta(wc, reasoning);
    if (trimmed.startsWith('data:')) {
      reportDocumentLimit(wc, messages, trimmed.slice(5).trim());
    }
  }, { firstEventTimeoutMs: MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS });
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
      }
    ) => {
      const { messages, config, locale: loc, temperature: tRaw } = payload;
      const locale = loc === 'en' ? 'en' : 'zh';
      const temperature =
        typeof tRaw === 'number' && Number.isFinite(tRaw)
          ? Math.max(0, Math.min(2, tRaw))
          : undefined;
      const wc = event.sender;
      const sid = typeof wc.id === 'number' ? wc.id : 0;
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
              if (!canFallbackAnthropicToOpenAi(config)) throw anthropicErr;
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
          if (ax?.name === 'CanceledError' || ac.signal.aborted) {
            sendEnd(wc);
          } else {
            sendErr(wc, mapModelCallError(e, locale));
            sendEnd(wc);
          }
        } finally {
          abortByStream.delete(sid);
        }
      })();
    }
  );

  ipcMain.on('model-stream-abort', (event) => {
    const sid = event.sender.id;
    abortByStream.get(sid)?.abort();
  });
}

registerModelStreamIpc();
