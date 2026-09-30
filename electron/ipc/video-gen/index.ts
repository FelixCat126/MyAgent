/**
 * 视频生成 IPC：api:generate-video 接 minimaxVideoAdapter（异步任务 + 轮询 + 落盘）。
 * v1 切片只支持 minimax provider；后续可扩 runway/kling。
 */
import { ipcMain } from 'electron';
import fs from 'fs/promises';
import { generateMiniMaxVideo, MiniMaxVideoError } from './minimaxVideoAdapter';
import type { ModelConfig } from '../../../src/types';

export interface GenerateVideoParams {
  /** 视频生成模型 ID（对应 model-store 中的 model.id），渲染端从 modelStore 取出 config 后传入 */
  modelId: string;
  prompt: string;
  /** 透传 videoGeneratorConfig（避免让 renderer 读 model-store） */
  videoGeneratorConfig?: ModelConfig['videoGeneratorConfig'];
  /** 流式事件 requestId（renderer 端发起的任务 ID，用于回调关联） */
  streamRequestId?: string;
}

interface VideoProgressEvent {
  requestId?: string;
  status: 'started' | 'polling' | 'completed' | 'failed';
  message?: string;
  localPath?: string;
  url?: string;
  /** 单文件场景；后续多文件模型可扩展 */
}

/**
 * 主 IPC：生成视频。返回本地路径 + 远端 URL；中间状态经 video-generation-progress 推送。
 */
ipcMain.handle('api:generate-video', async (event, params: GenerateVideoParams) => {
  const { videoGeneratorConfig, streamRequestId, prompt } = params || {};
  if (!prompt || !String(prompt).trim()) {
    return { ok: false as const, error: 'prompt 不能为空' };
  }
  const cfg = videoGeneratorConfig;
  if (!cfg || !cfg.provider || !cfg.model) {
    return { ok: false as const, error: '未配置视频生成工具：请在设置中添加视频模型' };
  }

  const emit = (payload: VideoProgressEvent) => {
    if (!streamRequestId) return;
    event.sender.send('video-generation-progress', payload);
  };

  try {
    emit({ requestId: streamRequestId, status: 'started' });
    if (cfg.provider === 'minimax') {
      if (!cfg.apiKey) {
        return { ok: false as const, error: 'MiniMax 视频模型未配置 API Key' };
      }
      emit({ requestId: streamRequestId, status: 'polling', message: '提交任务' });
      const result = await generateMiniMaxVideo({
        apiKey: cfg.apiKey,
        endpoint: cfg.endpoint,
        model: cfg.model,
        prompt: String(prompt).trim(),
        resolution: cfg.resolution,
        duration: cfg.duration,
      });
      emit({
        requestId: streamRequestId,
        status: 'completed',
        localPath: result.localPath,
        url: result.remoteUrl,
      });
      return { ok: true as const, localPath: result.localPath, url: result.remoteUrl };
    }
    return { ok: false as const, error: `视频 provider 「${cfg.provider}」未实现（v1 只支持 minimax）` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof MiniMaxVideoError) {
      return { ok: false as const, error: msg, code: e.code };
    }
    return { ok: false as const, error: msg };
  }
});

/**
 * 读视频文件转 data URL（renderer 加载 local-file:// 受限，用 base64 即可显示）。
 * 限制大小：超过 50MB 直接拒，提示用户改用外部播放器。
 */
ipcMain.handle('api:read-video', async (_e, filePath: string) => {
  const p = String(filePath || '').trim();
  if (!p) return { ok: false as const, error: '路径为空' };
  try {
    const st = await fs.stat(p);
    if (st.size > 50 * 1024 * 1024) {
      return { ok: false as const, error: `文件过大（${Math.round(st.size / 1024 / 1024)}MB > 50MB），请改用外部播放器` };
    }
    const buf = await fs.readFile(p);
    return { ok: true as const, dataUrl: `data:video/mp4;base64,${buf.toString('base64')}` };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
});

/** 用户主动取消：中止当前 minimax 任务（保留扩展点；v1 取消主要靠 renderer 端忽略结果） */
ipcMain.handle('api:cancel-video', async (_e, taskId: string) => {
  void taskId;
  return { ok: true as const, canceled: true as const };
});

/** 拿视频文件大小（视频附件注入 message.files 时需要 size 字段） */
ipcMain.handle('app:get-local-file-size', async (_e, filePath: string) => {
  const p = String(filePath || '').trim();
  if (!p) return { ok: false as const, error: '路径为空' };
  try {
    const { stat } = await import('fs/promises');
    const s = await stat(p);
    return { ok: true as const, size: s.size };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
});
