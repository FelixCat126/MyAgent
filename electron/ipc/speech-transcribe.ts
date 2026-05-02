import { ipcMain } from 'electron';
import axios from 'axios';
import FormData from 'form-data';
import type { ModelConfig } from '../../src/types';
import { resolveOpenAiCompatibleBaseUrl } from '../../src/utils/openAiCompatBase';

type TranscribePayload = {
  audio: number[];
  mimeType?: string;
  apiUrl: string;
  apiKey: string;
  provider: ModelConfig['provider'];
  /** 默认 whisper-1；部分中转可填自有模型 id */
  whisperModel?: string;
  /** ISO-639-1，如 zh、en */
  language?: string;
};

ipcMain.handle('transcribe-audio-openai', async (_e, payload: TranscribePayload) => {
  try {
    const key = String(payload.apiKey ?? '').trim();
    if (!key) return { ok: false as const, error: 'missing_api_key' };

    const buf = Buffer.from(payload.audio ?? []);
    if (buf.length < 64) return { ok: false as const, error: 'audio_too_short' };

    const mt = (payload.mimeType || 'audio/webm').split(';')[0]?.trim() || 'audio/webm';
    const ext =
      mt.includes('webm') ? 'webm' : mt.includes('mp4') || mt.includes('m4a') ? 'm4a' : mt.includes('wav') ? 'wav' : 'webm';

    const base = resolveOpenAiCompatibleBaseUrl(String(payload.apiUrl ?? '').trim(), payload.provider);
    const model = String(payload.whisperModel ?? '').trim() || 'whisper-1';

    const form = new FormData();
    form.append('file', buf, { filename: `speech.${ext}`, contentType: mt });
    form.append('model', model);
    const lang = String(payload.language ?? '').trim();
    if (lang === 'zh' || lang === 'en') form.append('language', lang);

    const { data, status } = await axios.post(`${base}/audio/transcriptions`, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${key}`,
      },
      timeout: 180_000,
      validateStatus: () => true,
    });

    if (status >= 200 && status < 300 && data && typeof (data as { text?: unknown }).text === 'string') {
      return { ok: true as const, text: String((data as { text: string }).text) };
    }

    let detail = '';
    if (typeof data === 'object' && data !== null && 'error' in data) {
      const er = (data as { error?: { message?: string } }).error?.message;
      if (typeof er === 'string') detail = er;
    }
    if (!detail && typeof data === 'string') detail = data;
    return { ok: false as const, error: detail || `http_${status}` };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false as const, error: msg.slice(0, 400) };
  }
});
