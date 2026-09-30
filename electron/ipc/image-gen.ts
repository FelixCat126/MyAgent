import { imageTaskContext, checkImageTask } from './image-gen/task';
import { ipcMain } from 'electron';
import type { ModelConfig, ImageGenerationParams } from '../../src/types';
import { enqueueSerializedImageGeneration } from './image-gen/queue';
import { generateImageHttp } from './image-gen/http';
import { generateImageCli } from './image-gen/cli';
import type { GeneratedImage, ImageGeneratedCallback } from './image-gen/adapters';

function isUsableImageConfig(
  c: ModelConfig['imageGeneratorConfig'] | undefined
): c is NonNullable<ModelConfig['imageGeneratorConfig']> {
  if (!c) return false;
  if (c.type === 'http') return Boolean(c.endpoint && String(c.endpoint).trim());
  return Boolean(c.command && String(c.command).trim());
}

const tasks = new Map<string, AbortController>();
ipcMain.on('image-generation-cancel', (event, requestId: string) => {
  tasks.get(`${event.sender.id}:${requestId}`)?.abort(new Error('已停止生图'));
});
ipcMain.handle('generate-image', (event, params: ImageGenerationParams) => {
  const key = `${event.sender.id}:${params.streamRequestId}`;
  if (tasks.has(key)) throw new Error('生图任务正在执行，请勿重复提交');
  const controller = new AbortController();
  tasks.set(key, controller);
  const onDestroyed = () => controller.abort(new Error('窗口已关闭'));
  event.sender.once('destroyed', onDestroyed);
  let queueKey = 'local';
  if (params.imageGeneratorConfig?.type === 'http') {
    try {
      const url = new URL(params.imageGeneratorConfig.endpoint || '');
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) queueKey = url.origin;
    } catch { /* Validation below reports an invalid endpoint. */ }
  }
  const job = enqueueSerializedImageGeneration(() => imageTaskContext.run(controller.signal, async () => {
    checkImageTask();
    return invokeGenerateImageIpc(params, (image, index, total) => {
      checkImageTask();
      if (!params.streamRequestId || event.sender.isDestroyed()) return;
      event.sender.send('image-generation-image', { requestId: params.streamRequestId, image, index, total });
    });
  }), queueKey);
  return job.finally(() => {
    event.sender.removeListener('destroyed', onDestroyed);
    if (tasks.get(key) === controller) tasks.delete(key);
  });
});

async function invokeGenerateImageIpc(params: ImageGenerationParams, onImage?: ImageGeneratedCallback) {
  checkImageTask();
  if (!params.prompt?.trim()) throw new Error('图片描述不能为空');
  if (params.count !== undefined && (!Number.isInteger(params.count) || params.count < 1 || params.count > 12)) throw new Error('单次图片数量必须为 1–12 张');
  for (const value of [params.width, params.height]) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value > 8192)) throw new Error('图片尺寸无效');
  }
  const config = params.imageGeneratorConfig;
  if (!isUsableImageConfig(config)) {
    throw new Error(
      '未配置图像生成工具：请在设置中添加模型并勾选「生图工具」，填写 CLI 或 HTTP；保存后重试。'
    );
  }

  try {
    if (config.type === 'http') {
      /** HTTP 多张补齐：各厂商单次请求有上限（百炼4、火山~15、OpenAI10、SDWebUI8、Ollama/raw1），
       *  当期望张数超过单次返回时，串行循环补齐，使最终总数尽量接近用户期望。 */
      const desiredCount =
        typeof params.count === 'number' && params.count > 0 ? Math.max(1, params.count) : 1;
      const collected: GeneratedImage[] = [];
      /** 安全上限：防止异常死循环 */
      const maxRounds = Math.min(12, Math.ceil(desiredCount / 1));
      for (let round = 0; round < maxRounds && collected.length < desiredCount; round++) {
        checkImageTask();
        const remaining = desiredCount - collected.length;
        const roundParams: ImageGenerationParams = {
          ...params,
          count: remaining,
        };
        const imgs = await generateImageHttp(roundParams, config);
        if (imgs.length === 0) break; // 厂商没返回，继续也没意义
        for (const img of imgs.slice(0, remaining)) {
          collected.push(img);
          onImage?.(img, collected.length, desiredCount);
        }
        /** 厂商单次就满足了，或本轮没进展（返回数<=0），停止避免空转 */
        if (imgs.length >= remaining) break;
      }
      return collected;
    }
    return await generateImageCli(params, config, onImage);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error('生图失败: ' + msg);
  }
}
