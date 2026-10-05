import { app, ipcMain, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { generateMiniMaxVideo, MiniMaxVideoError } from './minimaxVideoAdapter';
import type { ModelConfig } from '../../../src/types';
import type { RuntimeTask } from '../../../src/features/runtime/api';
import { getRuntimeLedger, notifyRuntimeChanged, registerRuntimeTaskCanceller, registerRuntimeTaskExecutor } from '../../workbench-runtime';
import { isAgentPathAllowed } from '../../utils/agentPathScope';
export interface GenerateVideoParams { modelId: string; prompt: string; videoGeneratorConfig?: ModelConfig['videoGeneratorConfig']; streamRequestId?: string }
interface VideoCheckpoint {
  version: 1; config: Omit<NonNullable<ModelConfig['videoGeneratorConfig']>, 'apiKey'>; sealedApiKey: string; prompt: string; modelId: string;
  submissionStarted?: boolean; remoteJobId?: string; endpoint?: string; localPath?: string; remoteUrl?: string;
}
const controllers = new Map<string, AbortController>(); const requestTasks = new Map<string, string>();
function protectKey(key: string): string { if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥存储不可用，无法安全保存视频任务 / Secure credential storage is unavailable'); return safeStorage.encryptString(key).toString('base64'); }
function revealKey(key: string): string { try { return safeStorage.decryptString(Buffer.from(key, 'base64')); } catch { throw new Error('视频任务密钥无法在本机解密，请重新配置后创建新任务 / Video credential cannot be decrypted on this machine'); } }
async function executeVideoTask(task: RuntimeTask, emit?: (p: Record<string, unknown>) => void) {
  const ledger = await getRuntimeLedger(); const checkpoint = task.checkpoint as unknown as VideoCheckpoint;
  if (!checkpoint || checkpoint.version !== 1 || !checkpoint.config?.model || !checkpoint.sealedApiKey) throw new Error('视频恢复数据不完整 / Video checkpoint is incomplete');
  if (controllers.has(task.id)) throw new Error('视频任务正在运行 / Video task already running');
  const controller = new AbortController(); controllers.set(task.id, controller);
  const checkRunning = () => { if (controller.signal.aborted || ledger.task(task.id).status === 'cancelled') { controller.abort(new Error('视频等待已取消 / Video wait cancelled')); throw controller.signal.reason; } };
  try {
    checkRunning();
    if (checkpoint.localPath && await fs.stat(checkpoint.localPath).then((s) => s.isFile() && s.size > 12).catch(() => false)) { const result = { localPath: checkpoint.localPath, remoteUrl: checkpoint.remoteUrl }; await ledger.finish(task.id, result); notifyRuntimeChanged(); return result; }
    if (checkpoint.submissionStarted && !checkpoint.remoteJobId) throw new Error('之前提交结果不确定；为避免重复付费不会自动重发，请先在厂商平台核对 / Prior submission outcome is unknown; automatic resubmission is disabled');
    if (!checkpoint.remoteJobId) { checkpoint.submissionStarted = true; await ledger.checkpoint(task.id, { ...checkpoint }); await ledger.step({ taskId: task.id, key: 'submit', title: '提交视频任务 / Submit video', status: 'running' }); notifyRuntimeChanged(); }
    checkRunning();
    const result = await generateMiniMaxVideo({ ...checkpoint.config, apiKey: revealKey(checkpoint.sealedApiKey), prompt: checkpoint.prompt, endpoint: checkpoint.endpoint ?? checkpoint.config.endpoint, existingTaskId: checkpoint.remoteJobId, signal: controller.signal, outputDir: path.join(app.getPath('documents'), 'MyAgent', 'GeneratedVideos'),
      onSubmitted: async (remoteJobId, endpoint) => { checkpoint.remoteJobId = remoteJobId; checkpoint.endpoint = endpoint; await ledger.recoveryCheckpoint(task.id, { ...checkpoint }); await ledger.step({ taskId: task.id, key: 'submit', title: '提交视频任务 / Submit video', status: 'completed', result: { remoteJobId } }); notifyRuntimeChanged(); },
      onProgress: status => { emit?.({ status: 'polling', message: status, taskId: task.id }); },
    });
    checkRunning(); checkpoint.localPath = result.localPath; checkpoint.remoteUrl = result.remoteUrl; await ledger.checkpoint(task.id, { ...checkpoint });
    await ledger.step({ taskId: task.id, key: 'download', title: '下载视频 / Download video', status: 'completed', result: { path: result.localPath } });
    checkRunning(); await ledger.finish(task.id, { localPath: result.localPath, url: result.remoteUrl }); checkRunning(); notifyRuntimeChanged(); return result;
  } catch (e) { if (controller.signal.aborted) await ledger.cancel(task.id); else await ledger.finish(task.id, undefined, e instanceof Error ? e.message : String(e)); notifyRuntimeChanged(); throw e; }
  finally { controllers.delete(task.id); }
}
registerRuntimeTaskExecutor('video-generation', async task => { await executeVideoTask(task); });
registerRuntimeTaskCanceller('video-generation', task => { controllers.get(task.id)?.abort(new Error('已停止本机视频等待 / Local video wait stopped')); });
ipcMain.handle('api:generate-video', async (event, params: GenerateVideoParams) => {
  const cfg = params?.videoGeneratorConfig; const requestKey = `${event.sender.id}:${params?.streamRequestId}`;
  if (requestTasks.has(requestKey)) return { ok: false, error: '视频任务正在运行 / Video task already running' };
  if (!params?.prompt?.trim() || !cfg?.model || cfg.provider !== 'minimax' || !cfg.apiKey) return { ok: false, error: '请配置可用的 MiniMax 视频模型、密钥和描述 / Configure a supported MiniMax video model and key' };
  const emit = (payload: Record<string, unknown>) => { if (params.streamRequestId && !event.sender.isDestroyed()) event.sender.send('video-generation-progress', { requestId: params.streamRequestId, ...payload }); };
  try {
    const ledger = await getRuntimeLedger(); const { apiKey, ...publicConfig } = cfg;
    const checkpoint: VideoCheckpoint = { version: 1, config: publicConfig, sealedApiKey: protectKey(apiKey), prompt: params.prompt.trim(), modelId: params.modelId };
    const task = await ledger.create({ title: `视频 / Video: ${params.prompt.slice(0, 80)}`, kind: 'video-generation', prompt: params.prompt, checkpoint: { ...checkpoint } });
    requestTasks.set(requestKey, task.id); await ledger.start(task.id); notifyRuntimeChanged(); emit({ status: 'started', taskId: task.id });
    const result = await executeVideoTask(task, emit); emit({ status: 'completed', taskId: task.id, localPath: result.localPath, url: result.remoteUrl });
    return { ok: true, taskId: task.id, localPath: result.localPath, url: result.remoteUrl };
  } catch (e) { const error = e instanceof Error ? e.message : String(e); emit({ status: 'failed', message: error }); return { ok: false, error, ...(e instanceof MiniMaxVideoError ? { code: e.code } : {}) }; }
  finally { requestTasks.delete(requestKey); }
});
ipcMain.handle('api:cancel-video', async (event, requestId: string) => {
  const id = requestTasks.get(`${event.sender.id}:${requestId}`); if (id) { controllers.get(id)?.abort(new Error('已停止本机等待；远端任务可能继续 / Local wait stopped; remote task may continue')); const ledger = await getRuntimeLedger(); await ledger.cancel(id); notifyRuntimeChanged(); }
  return { ok: true, canceled: true };
});
async function localVideoPath(raw: string) {
  const real = await fs.realpath(String(raw || '').trim()); if (!isAgentPathAllowed(real, [])) throw new Error('禁止读取系统路径 / System path denied'); return real;
}
ipcMain.handle('api:read-video', async (_event, raw: string) => {
  try { const file = await localVideoPath(raw); const stat = await fs.stat(file); if (!stat.isFile() || stat.size > 50 * 1024 * 1024) throw new Error('视频超过 50MB，请使用外部播放器 / Video exceeds 50MB; open in an external player'); const bytes = await fs.readFile(file); if (bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error('不是有效 MP4 / Not a valid MP4'); return { ok: true, dataUrl: `data:video/mp4;base64,${bytes.toString('base64')}` }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
ipcMain.handle('app:get-local-file-size', async (_event, raw: string) => {
  try { const file = await localVideoPath(raw); return { ok: true, size: (await fs.stat(file)).size }; } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
