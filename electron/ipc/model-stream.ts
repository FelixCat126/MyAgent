import { ipcMain, WebContents } from 'electron';
import axios, { type AxiosError } from 'axios';
import { ModelConfig, Message } from '../../src/types';
import { mapModelCallError } from '../../src/utils/modelErrors';
import {
  buildAnthropicAuthHeaders,
  buildAnthropicThinkingParams,
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
  withOpenAiCompatibleFallbacks,
} from './openai-chat-retry';
import { StreamingDeltaSplitter } from '../utils/streamChatCompletionDelta';

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
  const { system, messages: anthropicMessages } = formatAnthropicMessages(messages);
  const headers = buildAnthropicAuthHeaders({ apiKey, provider, apiUrl });
  let thinking = buildAnthropicThinkingParams({
    apiUrl,
    modelName,
    provider,
    maxTokens,
  });

  const postStream = (thinkingParams: { thinking: Record<string, unknown> }) => {
    const body: Record<string, unknown> = {
      model: modelName,
      max_tokens: Math.max(1, maxTokens || 4096),
      stream: true,
      ...thinkingParams,
      messages: anthropicMessages,
      ...(system ? { system } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
    };
    console.warn('[model-stream] Anthropic Messages 请求', {
      url: url.slice(0, 160),
      modelName,
      provider,
      chatApiMode: config.chatApiMode ?? 'auto',
      messageCount: anthropicMessages.length,
      hasSystem: Boolean(system),
      /** 脱敏：去掉 thinking 参数对象打印（避免配置细节泄漏），保留布尔指示 */
      thinkingEnabled: Boolean(thinkingParams.thinking),
    });
    return axios.post(url, body, {
      headers,
      responseType: 'stream',
      timeout: 300000,
      signal: ac.signal,
      validateStatus: (s) => s >= 200 && s < 300,
    });
  };

  const response = await postStream(thinking);

  const stream = response.data as NodeJS.ReadableStream & {
    on: (ev: 'data' | 'end' | 'error', fn: (x?: string | Buffer | Error) => void) => void;
  };

  let buffer = '';
  let diagLeft = 16;
  let thinkingChars = 0;
  let textChars = 0;

  const handleSseLine = (line: string) => {
    const trimmed = line.replace(/\r$/, '').trim();
    if (!trimmed.startsWith('data:')) return;
    const raw = trimmed.slice(5).trim();
    if (!raw || raw === '[DONE]') return;
    let j: {
      type?: string;
      content_block?: { type?: string };
      delta?: { type?: string; thinking?: string; text?: string };
    };
    try {
      j = JSON.parse(raw) as typeof j;
    } catch {
      return;
    }
    if (j.type === 'content_block_start' && diagLeft > 0) {
      diagLeft -= 1;
      console.warn('[model-stream] Anthropic block_start', {
        blockType: j.content_block?.type,
      });
      return;
    }
    if (j.type !== 'content_block_delta' || !j.delta) return;
    const dt = j.delta.type;
    if (diagLeft > 0) {
      diagLeft -= 1;
      console.warn('[model-stream] Anthropic delta', {
        deltaType: dt,
        thinkingLen: typeof j.delta.thinking === 'string' ? j.delta.thinking.length : 0,
        textLen: typeof j.delta.text === 'string' ? j.delta.text.length : 0,
      });
    }
    if (dt === 'thinking_delta' && typeof j.delta.thinking === 'string' && j.delta.thinking) {
      thinkingChars += j.delta.thinking.length;
      sendThinkingDelta(wc, j.delta.thinking);
    } else if (dt === 'text_delta' && typeof j.delta.text === 'string' && j.delta.text) {
      textChars += j.delta.text.length;
      sendDelta(wc, j.delta.text);
    }
  };

  stream.on('data', (chunk: string | Buffer) => {
    buffer += chunk.toString();
    const parts = buffer.split('\n');
    buffer = parts.pop() || '';
    for (const line of parts) handleSseLine(line);
  });

  await new Promise<void>((resolve, reject) => {
    stream.on('end', () => {
      if (buffer.trim()) {
        for (const ln of buffer.split('\n')) handleSseLine(ln);
      }
      console.warn('[model-stream] Anthropic 流结束', { thinkingChars, textChars });
      resolve();
    });
    stream.on('error', (e) => reject(e));
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
      timeout: 300000,
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

  let buffer = '';
  const stream = response.data as NodeJS.ReadableStream & {
    on: (ev: 'data' | 'end' | 'error', fn: (x?: string | Buffer | Error) => void) => void;
  };

  const splitter = new StreamingDeltaSplitter();
  stream.on('data', (chunk: string | Buffer) => {
    buffer += chunk.toString();
    const parts = buffer.split('\n');
    buffer = parts.pop() || '';
    for (const line of parts) {
      const trimmed = line.replace(/\r$/, '').trim();
      const { content, reasoning } = splitter.feed(trimmed);
      sendDelta(wc, content);
      sendThinkingDelta(wc, reasoning);
    }
  });
  await new Promise<void>((resolve, reject) => {
    stream.on('end', () => {
      if (buffer.trim()) {
        for (const ln of buffer.split('\n')) {
          const trimmed = ln.replace(/\r$/, '').trim();
          const { content, reasoning } = splitter.feed(trimmed);
          sendDelta(wc, content);
          sendThinkingDelta(wc, reasoning);
        }
      }
      splitter.flush();
      resolve();
    });
    stream.on('error', (e) => reject(e));
  });
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
