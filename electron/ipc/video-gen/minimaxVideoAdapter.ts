/**
 * MiniMax 视频生成 adapter（异步任务 + 轮询）。
 *
 * 调用流程：
 *  1) POST  /v1/video_generation     -> { task_id, base_resp }
 *  2) GET   /v1/video_generation/{task_id}  -> { status: PENDING|IN_PROGRESS|COMPLETED|FAILED, file_id?, base_resp }
 *  3) GET   /v1/files/retrieve?file_id=...  -> { file: { download_url } }
 *
 * 支持国内/国际站自动切换（与 image adapter 同策略）。
 */

import axios, { type AxiosInstance } from 'axios';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';

const HOST_INTL = 'api.minimax.io';
const HOST_CN = 'api.minimaxi.com';

export interface MiniMaxVideoConfig {
  apiKey: string;
  endpoint?: string;
  model: string;
  prompt: string;
  resolution?: '480' | '720' | '768' | '1080';
  duration?: 5 | 10;
  /** 轮询间隔 ms */
  pollIntervalMs?: number;
  /** 总超时 ms */
  timeoutMs?: number;
}

export interface MiniMaxVideoResult {
  /** 本地文件绝对路径（mp4） */
  localPath: string;
  /** 原始远程 URL（如果可获取） */
  remoteUrl?: string;
  /** 时长（毫秒，秒 * 1000），如果可从响应解析 */
  durationMs?: number;
}

export class MiniMaxVideoError extends Error {
  constructor(public code: number | string, message: string) {
    super(message);
    this.name = 'MiniMaxVideoError';
  }
}

function normalizeEndpoint(endpoint?: string): string {
  const raw = (endpoint || `https://${HOST_CN}/v1/video_generation`).trim();
  try {
    const u = new URL(raw);
    if (/^api\.minimax\.chat$/i.test(u.hostname)) {
      u.hostname = HOST_INTL;
    }
    u.pathname = '/v1/video_generation';
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return raw;
  }
}

function alternateEndpoint(endpoint: string): string | null {
  try {
    const u = new URL(normalizeEndpoint(endpoint));
    if (new RegExp(`^${HOST_CN}$`, 'i').test(u.hostname)) {
      u.hostname = HOST_INTL;
      return u.toString().replace(/\/$/, '');
    }
    if (new RegExp(`^${HOST_INTL}$`, 'i').test(u.hostname)) {
      u.hostname = HOST_CN;
      return u.toString().replace(/\/$/, '');
    }
  } catch {
    /* ignore */
  }
  return null;
}

function readBaseRespCode(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null;
  const br = (data as Record<string, unknown>).base_resp;
  if (!br || typeof br !== 'object') return null;
  const code = Number((br as Record<string, unknown>).status_code);
  return Number.isFinite(code) ? code : null;
}

function formatBaseRespError(code: number, msg: string): string {
  return `MiniMax 视频生成失败（status_code=${code}）：${msg || '请查阅 MiniMax 开放平台错误码说明'}`;
}

export function createMiniMaxClient(apiKey: string, baseEndpoint: string): AxiosInstance {
  const baseURL = baseEndpoint.replace(/\/v1\/.*$/, '/v1');
  return axios.create({
    baseURL,
    timeout: 60_000,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });
}

interface PollTaskResult {
  status?: string;
  file_id?: string;
  /** 任务最终原始响应（保留以便解析更多字段） */
  raw?: Record<string, unknown>;
}

/** 轮询任务状态，直到 COMPLETED / FAILED 或超时 */
async function pollTaskUntilDone(
  client: AxiosInstance,
  taskId: string,
  pollIntervalMs: number,
  timeoutMs: number
): Promise<PollTaskResult> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const { data } = await client.get(`/video_generation/${encodeURIComponent(taskId)}`);
    const code = readBaseRespCode(data);
    if (code !== null && code !== 0) {
      const br = (data as { base_resp?: { status_msg?: string } } | undefined)?.base_resp;
      const msg = String(br?.status_msg ?? '');
      throw new MiniMaxVideoError(code, formatBaseRespError(code, msg));
    }
    const d = (data as Record<string, unknown>) ?? {};
    const status = typeof d.status === 'string' ? d.status.toUpperCase() : '';
    if (status === 'COMPLETED' || status === 'SUCCESS' || status === 'FINISHED') {
      return {
        status: 'COMPLETED',
        file_id: typeof d.file_id === 'string' ? d.file_id : undefined,
        raw: d,
      };
    }
    if (status === 'FAILED' || status === 'ERROR' || status === 'CANCELLED') {
      const br = d.base_resp as { status_msg?: string } | undefined;
      const msg = String(br?.status_msg ?? status);
      throw new MiniMaxVideoError(status, `MiniMax 视频任务失败：${msg}`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new MiniMaxVideoError('timeout', `MiniMax 视频任务超过 ${Math.round(timeoutMs / 1000)}s 仍未完成`);
}

/** 拿 file_id 下载视频；MiniMax 的 file 接口标准：GET /v1/files/retrieve?file_id=... */
async function downloadByFileId(
  client: AxiosInstance,
  fileId: string,
  destPath: string
): Promise<string> {
  /** 先尝试 retrieve 拿 download_url，再直下；retrieve 失败时直接 GET task 取 video_url */
  let videoUrl: string | null = null;
  try {
    const { data } = await client.get('/files/retrieve', { params: { file_id: fileId } });
    const d = data as Record<string, unknown>;
    const file = (d.file && typeof d.file === 'object' ? d.file : null) as
      | Record<string, unknown>
      | null;
    const u = file?.download_url ?? file?.url;
    if (typeof u === 'string' && /^https?:\/\//i.test(u)) videoUrl = u;
  } catch {
    /* retrieve 接口不可用 → 走 task 兜底 */
  }
  if (!videoUrl) {
    throw new MiniMaxVideoError(
      'no_url',
      'MiniMax 视频任务完成但未返回 download_url；可能是接口差异，需扩展 adapter'
    );
  }
  const resp = await axios.get<ArrayBuffer>(videoUrl, { responseType: 'arraybuffer', timeout: 120_000 });
  await fs.writeFile(destPath, Buffer.from(resp.data));
  return videoUrl;
}

export async function generateMiniMaxVideo(
  config: MiniMaxVideoConfig
): Promise<MiniMaxVideoResult> {
  const pollIntervalMs = config.pollIntervalMs ?? 8000;
  const timeoutMs = config.timeoutMs ?? 10 * 60 * 1000;
  const endpoint = normalizeEndpoint(config.endpoint);
  const client = createMiniMaxClient(config.apiKey, endpoint);

  /** 提交任务；MiniMax 2049 = 站点与 Key 不匹配 → 自动切站重试一次 */
  const submitBody: Record<string, unknown> = {
    model: config.model,
    prompt: config.prompt,
  };
  if (config.resolution) submitBody.resolution = config.resolution;
  if (config.duration) submitBody.duration = config.duration;

  let submitResp;
  let usedEndpoint = endpoint;
  try {
    submitResp = await client.post('/video_generation', submitBody);
  } catch (e) {
    const alt = alternateEndpoint(endpoint);
    if (!alt) throw e;
    usedEndpoint = alt;
    const altClient = createMiniMaxClient(config.apiKey, alt);
    submitResp = await altClient.post('/video_generation', submitBody);
  }

  const submitCode = readBaseRespCode(submitResp.data);
  if (submitCode !== null && submitCode !== 0) {
    const br = (submitResp.data as { base_resp?: { status_msg?: string } } | undefined)?.base_resp;
    const msg = String(br?.status_msg ?? '');
    throw new MiniMaxVideoError(submitCode, formatBaseRespError(submitCode, msg));
  }
  const taskId = String((submitResp.data as Record<string, unknown>)?.task_id ?? '');
  if (!taskId) {
    throw new MiniMaxVideoError('no_task_id', 'MiniMax 视频创建任务未返回 task_id');
  }

  const usedClient = usedEndpoint === endpoint ? client : createMiniMaxClient(config.apiKey, usedEndpoint);
  const done = await pollTaskUntilDone(usedClient, taskId, pollIntervalMs, timeoutMs);

  /** 落盘：~/Documents/MyAgent/GeneratedVideos/<taskId>.mp4 */
  const docsDir = path.join(os.homedir(), 'Documents', 'MyAgent', 'GeneratedVideos');
  await fs.mkdir(docsDir, { recursive: true });
  const fileName = `minimax-video-${taskId}-${randomUUID().slice(0, 6)}.mp4`;
  const localPath = path.join(docsDir, fileName);

  if (!done.file_id) {
    throw new MiniMaxVideoError(
      'no_file_id',
      'MiniMax 视频任务完成但未返回 file_id；无法下载'
    );
  }
  const remoteUrl = await downloadByFileId(usedClient, done.file_id, localPath);

  return { localPath, remoteUrl };
}
