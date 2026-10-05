/** MiniMax v1 asynchronous video jobs. Persist task_id before polling; resume never resubmits. */
import axios, { type AxiosInstance } from 'axios';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export interface MiniMaxVideoConfig {
  apiKey: string; endpoint?: string; model: string; prompt: string;
  resolution?: '480' | '720' | '768' | '1080'; duration?: 5 | 6 | 10;
  pollIntervalMs?: number; timeoutMs?: number; signal?: AbortSignal;
  existingTaskId?: string; outputDir?: string;
  onSubmitted?: (taskId: string, endpoint: string) => Promise<void>;
  onProgress?: (status: string) => void;
}
export interface MiniMaxVideoResult { localPath: string; remoteUrl?: string; durationMs?: number; taskId: string; endpoint: string }
export class MiniMaxVideoError extends Error { constructor(public code: number | string, message: string) { super(message); this.name = 'MiniMaxVideoError'; } }
export function normalizeEndpoint(endpoint?: string): string {
  const url = new URL((endpoint || 'https://api.minimaxi.com/v1/video_generation').trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new MiniMaxVideoError('endpoint', '无效视频接口地址 / Invalid video endpoint');
  if (/^api\.minimax\.chat$/i.test(url.hostname)) url.hostname = 'api.minimax.io';
  url.pathname = '/v1/video_generation'; url.search = ''; url.hash = ''; return url.toString();
}
function alternateEndpoint(endpoint: string): string | null {
  const url = new URL(endpoint);
  if (['api.minimaxi.com', 'api.minimax.cn'].includes(url.hostname)) url.hostname = 'api.minimax.io';
  else if (url.hostname === 'api.minimax.io') url.hostname = 'api.minimaxi.com'; else return null;
  return url.toString();
}
function validateResponse(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new MiniMaxVideoError('invalid_response', '视频服务返回非 JSON 结果 / Invalid video service response');
  const result = data as Record<string, unknown>; const base = result.base_resp as { status_code?: number; status_msg?: string } | undefined;
  if (base?.status_code !== undefined && Number(base.status_code) !== 0) throw new MiniMaxVideoError(Number(base.status_code), `MiniMax 视频错误 ${base.status_code}: ${String(base.status_msg ?? '')}`);
  return result;
}
export function createMiniMaxClient(apiKey: string, endpoint: string): AxiosInstance {
  return axios.create({ baseURL: endpoint.replace(/\/v1\/.*$/, '/v1'), timeout: 60_000, maxContentLength: 2 * 1024 * 1024, maxBodyLength: 2 * 1024 * 1024, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
}
async function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted(); await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
export async function generateMiniMaxVideo(config: MiniMaxVideoConfig): Promise<MiniMaxVideoResult> {
  if (!config.apiKey?.trim() || !config.model?.trim() || !config.prompt?.trim()) throw new MiniMaxVideoError('config', '请配置视频密钥、模型和描述 / Video key, model and prompt required');
  if (/^MiniMax-H3/i.test(config.model)) throw new MiniMaxVideoError('unsupported_model', 'H3 使用 v2 多模态协议，当前适配器支持 Hailuo v1，请选择已支持的模型。 / H3 requires a separate v2 adapter.');
  const controller = new AbortController(); const externalAbort = () => controller.abort(config.signal?.reason ?? new Error('视频已取消 / Video canceled'));
  if (config.signal?.aborted) externalAbort(); else config.signal?.addEventListener('abort', externalAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new MiniMaxVideoError('timeout', '视频等待超时，可从任务列表继续 / Video wait timed out; resume from Tasks')), config.timeoutMs ?? 10 * 60_000);
  const signal = controller.signal; let temp: string | undefined;
  try {
    signal.throwIfAborted(); let endpoint = normalizeEndpoint(config.endpoint); let client = createMiniMaxClient(config.apiKey, endpoint); let taskId = config.existingTaskId;
    if (!taskId) {
      const body = { model: config.model, prompt: config.prompt, ...(config.resolution ? { resolution: config.resolution } : {}), ...(config.duration ? { duration: config.duration } : {}) };
      let submitted: Record<string, unknown>;
      try { submitted = validateResponse((await client.post('/video_generation', body, { signal })).data); }
      catch (e) { const alternate = e instanceof MiniMaxVideoError && e.code === 2049 ? alternateEndpoint(endpoint) : null; if (!alternate) throw e; endpoint = alternate; client = createMiniMaxClient(config.apiKey, endpoint); submitted = validateResponse((await client.post('/video_generation', body, { signal })).data); }
      taskId = typeof submitted.task_id === 'string' || typeof submitted.task_id === 'number' ? String(submitted.task_id) : '';
      if (!taskId) throw new MiniMaxVideoError('no_task_id', '视频创建结果没有 task_id / Video response has no task_id');
      await config.onSubmitted?.(taskId, endpoint);
    }
    signal.throwIfAborted(); let fileId: string | undefined;
    while (!fileId) {
      signal.throwIfAborted(); const status = validateResponse((await client.get('/query/video_generation', { params: { task_id: taskId }, signal })).data);
      const state = String(status.status ?? '').toUpperCase(); config.onProgress?.(state);
      if (['SUCCESS', 'COMPLETED', 'FINISHED'].includes(state)) {
        fileId = typeof status.file_id === 'string' || typeof status.file_id === 'number' ? String(status.file_id) : undefined;
        if (!fileId) throw new MiniMaxVideoError('no_file_id', '视频已完成但没有 file_id / Completed video has no file_id');
      } else if (['FAIL', 'FAILED', 'ERROR', 'CANCELLED', 'CANCELED'].includes(state)) throw new MiniMaxVideoError(state, `视频任务失败 / Video task failed: ${state}`);
      else if (!['PREPARING', 'QUEUEING', 'PROCESSING', 'PENDING', 'IN_PROGRESS'].includes(state)) throw new MiniMaxVideoError('unknown_status', `未知视频状态 / Unknown video status: ${state || '(empty)'}`);
      else await pause(Math.max(1, config.pollIntervalMs ?? 8000), signal);
    }
    const retrieved = validateResponse((await client.get('/files/retrieve', { params: { file_id: fileId }, signal })).data); const file = retrieved.file as { download_url?: string; url?: string } | undefined;
    const remoteUrl = file?.download_url ?? file?.url;
    if (!remoteUrl || !/^https?:\/\//i.test(remoteUrl)) throw new MiniMaxVideoError('no_url', '视频下载链接缺失 / Video download URL missing');
    const response = await axios.get<ArrayBuffer>(remoteUrl, { responseType: 'arraybuffer', timeout: 120_000, maxContentLength: 200 * 1024 * 1024, signal });
    const bytes = Buffer.from(response.data);
    if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw new MiniMaxVideoError('invalid_video', '下载结果不是有效 MP4 容器 / Download is not an MP4 container');
    signal.throwIfAborted(); const directory = config.outputDir ?? path.join(os.homedir(), 'Documents', 'MyAgent', 'GeneratedVideos'); await fs.mkdir(directory, { recursive: true });
    const localPath = path.join(directory, `minimax-video-${taskId.replace(/[^a-z0-9-]/gi, '_')}-${randomUUID().slice(0, 8)}.mp4`); temp = localPath + '.tmp';
    await fs.writeFile(temp, bytes, { mode: 0o600 }); signal.throwIfAborted(); await fs.rename(temp, localPath); temp = undefined;
    return { localPath, remoteUrl, taskId, endpoint };
  } finally { clearTimeout(timeout); config.signal?.removeEventListener('abort', externalAbort); if (temp) await fs.unlink(temp).catch(() => {}); }
}
