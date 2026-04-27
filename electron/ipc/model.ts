import { ipcMain } from 'electron';
import axios from 'axios';
import { ModelConfig, Message } from '../../src/types';
import { mapModelCallError } from '../../src/utils/modelErrors';
import {
  errorIndicatesImageUnsupported,
  formatOpenAIMultimodal,
  formatOpenAITextOnly,
  isZhipuEndpoint,
  messagesHaveImageFiles,
  resolveOpenAiCompatibleBaseUrl,
} from './openai-adapters';

/** Claude / Gemini 需单独处理 system；OpenAI 兼容接口一般可直接带 system 消息 */
function splitSystemMessages(messages: Message[]): { systemText: string; convo: Message[] } {
  const systemText = messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter(Boolean)
    .join('\n\n');
  const convo = messages.filter((m) => m.role !== 'system');
  return { systemText, convo };
}

function parseOpenAIChatResponse(responseData: { choices?: Array<{ message?: { content?: string } }> }) {
  if (responseData.choices?.[0]?.message?.content != null) {
    return {
      content: responseData.choices[0].message.content as string,
      usage: (responseData as { usage?: unknown }).usage,
    };
  }
  console.error('Unexpected response format:', responseData);
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
    options?: { locale?: 'zh' | 'en' }
  ) => {
  const locale = options?.locale === 'en' ? 'en' : 'zh';
  try {
    const { provider, apiUrl, apiKey, modelName, maxTokens } = config;

    const isZhipuAI = isZhipuEndpoint(apiUrl, modelName);

    // OpenAI / Compatible API（智谱、自定义、Ollama 等）：不做「是否支持图」的客户端猜测，交给接口报错
    if (provider === 'openai' || provider === 'custom' || provider === 'ollama' || isZhipuAI) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      
      if (isZhipuAI && apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      } else if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const apiBase = resolveOpenAiCompatibleBaseUrl(apiUrl, provider);
      let formattedMessages = formatOpenAIMultimodal(messages);

      const postChat = () =>
        axios.post(
          `${apiBase}/chat/completions`,
          {
            model: modelName,
            messages: formattedMessages,
            max_tokens: maxTokens,
          },
          {
            headers,
            timeout: 120000,
          }
        );

      try {
        const response = await postChat();
        return parseOpenAIChatResponse(response.data);
      } catch (firstErr: unknown) {
        if (
          messagesHaveImageFiles(messages) &&
          errorIndicatesImageUnsupported(firstErr)
        ) {
          console.warn(
            '[call-model] 接口拒绝图像输入，已自动改为纯文字重试一次:',
            (firstErr as Error).message
          );
          formattedMessages = formatOpenAITextOnly(messages);
          const response = await postChat();
          return parseOpenAIChatResponse(response.data);
        }
        throw firstErr;
      }
    }

    // Claude API
    if (provider === 'claude') {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-api-key': apiKey || '',
        'anthropic-version': '2023-06-01',
      };

      const { systemText, convo } = splitSystemMessages(messages);

      const formattedMessages = convo.map(msg => {
        if (msg.files && msg.files.some(f => f.type.startsWith('image/'))) {
          const imageFile = msg.files.find(f => f.type.startsWith('image/'));
          return {
            role: msg.role,
            content: [
              {
                type: 'text',
                text: msg.content
              },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: imageFile?.type || 'image/png',
                  data: imageFile?.preview ? imageFile.preview.split(',')[1] : null
                }
              }
            ]
          };
        }
        return {
          role: msg.role,
          content: msg.content
        };
      });

      const response = await axios.post(
        `${apiUrl}/messages`,
        {
          model: modelName,
          ...(systemText ? { system: systemText } : {}),
          messages: formattedMessages,
          max_tokens: maxTokens,
        },
        {
          headers,
          timeout: 60000,
        }
      );

      if (response.data.type === 'error') {
        throw new Error(response.data.error);
      }

      return {
        content: response.data.content[0]?.text || '',
        usage: response.data.usage,
      };
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
        if (msg.files && msg.files.some(f => f.type.startsWith('image/'))) {
          const imageFile = msg.files.find(f => f.type.startsWith('image/'));
          return {
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [
              { text: msg.content },
              {
                inline_data: {
                  mime_type: imageFile?.type || 'image/png',
                  data: imageFile?.preview ? imageFile.preview.split(',')[1] : null
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
          timeout: 60000,
        }
      );

      const text = response.data.candidates[0]?.content?.parts[0]?.text || '';
      return { content: text };
    }

    throw new Error(`Unsupported model provider: ${provider}`);
  } catch (error: any) {
    console.error('Model call error:', error);
    const msg = mapModelCallError(error, locale);
    throw new Error(msg);
  }
});

console.log('✅ 模型调用 IPC 处理器已注册（支持智谱AI GLM-4）');