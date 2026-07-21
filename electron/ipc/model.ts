import { ipcMain } from 'electron';
import axios from 'axios';
import { ModelConfig, Message } from '../../src/types';
import { mapModelCallError } from '../../src/utils/modelErrors';
import {
  buildAnthropicAuthHeaders,
  buildAnthropicThinkingParams,
  parseAnthropicContentBlocks,
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
import { DEFAULT_MAX_TOKENS } from '../constants/limits';
import { GEMINI_HTTP_TIMEOUT_MS, MODEL_HTTP_TIMEOUT_MS } from '../constants/timeouts';

/** Gemini 需单独处理 system；OpenAI 兼容接口一般可直接带 system 消息 */
function splitSystemMessages(messages: Message[]): { systemText: string; convo: Message[] } {
  const systemText = messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter(Boolean)
    .join('\n\n');
  const convo = messages.filter((m) => m.role !== 'system');
  return { systemText, convo };
}

async function callAnthropicMessages(opts: {
  messages: Message[];
  config: ModelConfig;
  temperature: number | undefined;
}): Promise<{ content: string; reasoning?: string; usage?: unknown }> {
  const { messages, config, temperature } = opts;
  const { apiUrl, apiKey, modelName, maxTokens, provider } = config;
  const { system, messages: anthropicMessages } = formatAnthropicMessages(messages);
  let thinking = buildAnthropicThinkingParams({
    apiUrl,
    modelName,
    provider,
    maxTokens,
  });
  const response = await axios.post(
    resolveAnthropicMessagesUrl(apiUrl),
    {
      model: modelName,
      max_tokens: Math.max(1, maxTokens || DEFAULT_MAX_TOKENS),
      ...thinking,
      messages: anthropicMessages,
      ...(system ? { system } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
    },
    {
      headers: buildAnthropicAuthHeaders({ apiKey, provider, apiUrl }),
      timeout: MODEL_HTTP_TIMEOUT_MS,
    }
  );
  return parseAnthropicContentBlocks(response.data);
}

function parseOpenAIMessageBlock(msg?: {
  content?: unknown;
  reasoning_content?: unknown;
  reasoning?: unknown;
  thinking?: unknown;
  reasoning_details?: unknown;
}): { content: string; reasoning?: string } {
  let content =
    typeof msg?.content === 'string' ? msg.content : '';
  let reasoning = '';
  for (const k of ['reasoning_content', 'reasoning', 'thinking'] as const) {
    const v = msg?.[k];
    if (typeof v === 'string' && v) {
      reasoning = v;
      break;
    }
  }
  /** MiniMax reasoning_split：reasoning_details 可能为字符串或含 text 的数组 */
  if (!reasoning && msg?.reasoning_details != null) {
    const rd = msg.reasoning_details;
    if (typeof rd === 'string' && rd.trim()) {
      reasoning = rd;
    } else if (Array.isArray(rd)) {
      reasoning = rd
        .map((item) => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
            return (item as { text: string }).text;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
  }
  /** 兜底：思考仍嵌在 content 的 <think> 标签里（MiniMax 默认流式/未 split） */
  if (content && /<\/?think\w*\b/i.test(content)) {
    const extracted = extractInlineThinkTags(content);
    content = extracted.content;
    if (!reasoning && extracted.reasoning) reasoning = extracted.reasoning;
    else if (reasoning && extracted.reasoning) {
      /** 已有 reasoning 字段时仍去掉 content 里的标签，避免正文重复 */
      content = extracted.content;
    }
  }
  return reasoning ? { content, reasoning } : { content };
}

/** 从完整正文中拆出 <think>…</think>（非流式兜底；流式由 StreamingDeltaSplitter 处理） */
function extractInlineThinkTags(text: string): { content: string; reasoning: string } {
  const tagRe = /<\/?think\w*[^>]*>/gi;
  let contentOut = '';
  let reasoningOut = '';
  let inThink = false;
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(text)) !== null) {
    const between = text.slice(lastIdx, match.index);
    if (inThink) reasoningOut += between;
    else contentOut += between;
    if (/^<\//i.test(match[0])) inThink = false;
    else inThink = true;
    lastIdx = match.index + match[0].length;
  }
  const tail = text.slice(lastIdx);
  if (inThink) reasoningOut += tail;
  else contentOut += tail;
  return { content: contentOut, reasoning: reasoningOut.trim() };
}

function parseOpenAIChatResponse(responseData: {
  choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; thinking?: unknown } }>;
}) {
  const msg = responseData.choices?.[0]?.message;
  if (msg != null && msg.content != null) {
    const { content, reasoning } = parseOpenAIMessageBlock(msg);
    return {
      content,
      ...(reasoning?.trim() ? { reasoning } : {}),
      usage: (responseData as { usage?: unknown }).usage,
    };
  }
  console.error(
    'Unexpected response format:',
    responseData && typeof responseData === 'object'
      ? { topKeys: Object.keys(responseData).slice(0, 10) }
      : typeof responseData
  );
  /** 不打印完整响应体，避免模型输出/敏感内容泄漏到 stdout。 */
  return {
    content: '收到未能正确解析的响应，请检查模型配置。',
    usage: (responseData as { usage?: unknown }).usage,
  };
}

ipcMain.handle(
  'call-model',
  async (
    _event,
    messages: Message[],
    config: ModelConfig,
    options?: { locale?: 'zh' | 'en'; temperature?: number }
  ) => {
  const locale = options?.locale === 'en' ? 'en' : 'zh';
  const temperature =
    typeof options?.temperature === 'number' && Number.isFinite(options.temperature)
      ? Math.max(0, Math.min(2, options.temperature))
      : undefined;
  try {
    const { provider, apiUrl, apiKey, modelName, maxTokens } = config;

    const isZhipuAI = isZhipuEndpoint(apiUrl, modelName);
    const apiMode = resolveChatApiMode(config);

    /** 通用 Anthropic Messages（provider=claude 或 chatApiMode 解析为 anthropic） */
    if (provider === 'claude' || apiMode === 'anthropic') {
      try {
        return await callAnthropicMessages({ messages, config, temperature });
      } catch (anthropicErr: unknown) {
        if (!canFallbackAnthropicToOpenAi(config)) throw anthropicErr;
        console.warn('[call-model] Anthropic 失败，回退 OpenAI 兼容', {
          message: anthropicErr instanceof Error ? anthropicErr.message : String(anthropicErr),
        });
      }
    }

    // OpenAI / Compatible API（智谱、自定义、Ollama 等）：不做「是否支持图」的客户端猜测，交给接口报错
    if (provider === 'openai' || provider === 'custom' || provider === 'ollama' || isZhipuAI) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const apiBase = resolveOpenAiCompatibleBaseUrl(apiUrl, provider);
      const multimodal = formatOpenAIMultimodal(messages);
      const textOnly = formatOpenAITextOnly(messages);

      const postChat = (mode: 'multimodal' | 'text', withThinking: boolean) =>
        axios.post(
          `${apiBase}/chat/completions`,
          {
            model: modelName,
            messages: mode === 'multimodal' ? multimodal : textOnly,
            max_tokens: maxTokens,
            ...(temperature !== undefined ? { temperature } : {}),
            ...(withThinking ? buildThinkingParams({ apiUrl, modelName, stream: false }) : {}),
          },
          {
            headers,
            timeout: MODEL_HTTP_TIMEOUT_MS,
          }
        );

      const response = await withOpenAiCompatibleFallbacks({
        messages,
        messagesHaveImages: messagesHaveImageFiles(messages),
        errorIndicatesImageUnsupported,
        request: async (mode, withThinking) => postChat(mode, withThinking),
        onImageFallback: (err) => {
          console.warn(
            '[call-model] 接口拒绝图像输入，已自动改为纯文字重试一次:',
            err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)
          );
        },
      });
      return parseOpenAIChatResponse(response.data);
    }

    // Gemini API
    if (provider === 'gemini') {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (apiKey) {
        headers['x-goog-api-key'] = apiKey;
      }

      const { systemText, convo } = splitSystemMessages(messages);

      const formattedMessages = convo.map(msg => {
        const imageFile = msg.files?.find(f => f.type.startsWith('image/'));
        /** preview 缺失或不含 base64 段时退化为纯文本，避免向 Gemini 发 inline_data.data=null */
        const b64 =
          imageFile?.preview && imageFile.preview.includes(',')
            ? imageFile.preview.split(',')[1]
            : '';
        if (imageFile && b64) {
          return {
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [
              { text: msg.content },
              {
                inline_data: {
                  mime_type: imageFile.type || 'image/png',
                  data: b64
                }
              }
            ]
          };
        }
        return {
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }]
        };
      });

      if (systemText && formattedMessages.length > 0) {
        const first = formattedMessages[0];
        const prefix = `【系统与检索上下文】\n${systemText}\n\n---\n\n`;
        if (first.parts?.length) {
          const p0 = first.parts[0];
          if (p0 && 'text' in p0 && typeof p0.text === 'string') {
            p0.text = prefix + p0.text;
          } else {
            first.parts.unshift({ text: prefix.trimEnd() });
          }
        }
      }

      const response = await axios.post(
        `${apiUrl}/${modelName}:generateContent`,
        {
          contents: formattedMessages,
          generationConfig: {
            maxOutputTokens: maxTokens,
          },
        },
        {
          headers,
          timeout: GEMINI_HTTP_TIMEOUT_MS,
        }
      );

      /** Gemini 返回 parts 数组：thought=true 的是思考过程，其余是正文 */
      const parts: Array<{ text?: string; thought?: boolean }> = Array.isArray(
        response.data.candidates?.[0]?.content?.parts
      )
        ? response.data.candidates[0].content.parts
        : [];
      const reasoning = parts
        .filter((p) => p.thought === true && typeof p.text === 'string')
        .map((p) => p.text as string)
        .join('\n');
      const content = parts
        .filter((p) => !p.thought && typeof p.text === 'string')
        .map((p) => p.text as string)
        .join('\n');
      return {
        content: content || '',
        ...(reasoning.trim() ? { reasoning } : {}),
      };
    }

    throw new Error(`Unsupported model provider: ${provider}`);
  } catch (error: unknown) {
    /** 脱敏：只打印错误分类，避免完整 error 对象（含 URL/key/响应内容）泄漏 */
    const ax = error as { response?: { status?: number }; code?: string; message?: string };
    console.error('Model call error:', {
      provider: config?.provider,
      model: config?.modelName,
      status: ax?.response?.status,
      code: ax?.code,
      message: typeof ax?.message === 'string' ? ax.message.slice(0, 200) : undefined,
    });
    const msg = mapModelCallError(error, locale);
    throw new Error(msg);
  }
});

console.log('✅ 模型调用 IPC 处理器已注册');