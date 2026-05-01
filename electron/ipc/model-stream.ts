import { ipcMain, WebContents } from 'electron';
import axios, { type AxiosError } from 'axios';
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
import { extractContentAndReasoningFromSseDataLine } from '../utils/streamChatCompletionDelta';

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

function registerModelStreamIpc() {
  ipcMain.on('model-stream-start', (event, payload: { messages: Message[]; config: ModelConfig; locale?: 'zh' | 'en' }) => {
    const { messages, config, locale: loc } = payload;
    const locale = loc === 'en' ? 'en' : 'zh';
    const wc = event.sender;
    const sid = typeof wc.id === 'number' ? wc.id : 0;
    const prev = abortByStream.get(sid);
    prev?.abort();
    const ac = new AbortController();
    abortByStream.set(sid, ac);

    void (async () => {
      try {
        const { provider, apiUrl, apiKey, modelName, maxTokens } = config;
        const isZhipu = isZhipuEndpoint(apiUrl, modelName);
        const apiBase = resolveOpenAiCompatibleBaseUrl(apiUrl, provider);
        if (provider !== 'openai' && provider !== 'custom' && provider !== 'ollama' && !isZhipu) {
          sendErr(wc, '当前提供商不支持流式输出，请使用 OpenAI/兼容 或 Ollama，或关闭流式。');
          sendEnd(wc);
          return;
        }

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }

        let formattedMessages = formatOpenAIMultimodal(messages) as Array<{ role: string; content: unknown }>;

        const doStream = async (msgs: typeof formattedMessages) => {
          const body: Record<string, unknown> = {
            model: modelName,
            messages: msgs,
            max_tokens: maxTokens,
            stream: true,
          };
          const url = `${apiBase}/chat/completions`;
          return axios.post(url, body, {
            headers,
            responseType: 'stream',
            timeout: 300000,
            signal: ac.signal,
            validateStatus: (s) => s >= 200 && s < 300,
          });
        };

        const tryRequest = async () => {
          try {
            return await doStream(formattedMessages);
          } catch (firstErr: unknown) {
            if (messagesHaveImageFiles(messages) && errorIndicatesImageUnsupported(firstErr)) {
              formattedMessages = formatOpenAITextOnly(messages) as Array<{
                role: string;
                content: unknown;
              }>;
              return await doStream(formattedMessages);
            }
            throw firstErr;
          }
        };

        let buffer = '';
        const response = await tryRequest();
        const stream = response.data as NodeJS.ReadableStream & {
          on: (ev: 'data' | 'end' | 'error', fn: (x?: string | Error) => void) => void;
        };

        /** OpenAI 兼容流（含多数 Ollama /v1/chat/completions）为 SSE */
        stream.on('data', (chunk: string | Buffer) => {
          buffer += chunk.toString();
          const parts = buffer.split('\n');
          buffer = parts.pop() || '';
          for (const line of parts) {
            const trimmed = line.replace(/\r$/, '').trim();
            const { content, reasoning } = extractContentAndReasoningFromSseDataLine(trimmed);
            sendDelta(wc, content);
            sendThinkingDelta(wc, reasoning);
          }
        });
        await new Promise<void>((resolve, reject) => {
          stream.on('end', () => {
            if (buffer.trim()) {
              for (const ln of buffer.split('\n')) {
                const trimmed = ln.replace(/\r$/, '').trim();
                const { content, reasoning } = extractContentAndReasoningFromSseDataLine(trimmed);
                sendDelta(wc, content);
                sendThinkingDelta(wc, reasoning);
              }
            }
            resolve();
          });
          stream.on('error', (e) => reject(e));
        });
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
  });

  ipcMain.on('model-stream-abort', (event) => {
    const sid = event.sender.id;
    abortByStream.get(sid)?.abort();
  });
}

registerModelStreamIpc();
