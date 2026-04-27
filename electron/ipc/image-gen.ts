import { ipcMain } from 'electron';
import { spawn } from 'child_process';
import { join } from 'path';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import { type ModelConfig, ImageGenerationParams } from '../../src/types';

function looksLikeWindowsExec(cmd: string): boolean {
  return /\.(cmd|bat|ps1)$/i.test(cmd.trim());
}

/** 占位符替换；prompt 可能含特殊字符，按「整段 argv」传入 */
function applyCliPlaceholders(
  line: string,
  params: ImageGenerationParams,
  outputPath: string
): string {
  const w = String(params.width ?? 512);
  const h = String(params.height ?? 512);
  const p = params.prompt ?? '';
  return line
    .replace(/\{\{prompt\}\}/g, p)
    .replace(/\{\{outputPath\}\}/g, outputPath)
    .replace(/\{\{width\}\}/g, w)
    .replace(/\{\{height\}\}/g, h);
}

/** 从 HTTP JSON 中提取第一张 PNG/JPEG base64 */
function extractImageBufferFromJson(
  data: unknown,
  mode: 'sdwebui' | 'ollama' | 'auto'
): Buffer | null {
  if (!data || typeof data !== 'object') return null;
  const j = data as Record<string, unknown>;

  if (mode === 'sdwebui' || mode === 'auto') {
    const imgs = j.images;
    if (Array.isArray(imgs) && typeof imgs[0] === 'string') {
      try {
        return Buffer.from(imgs[0], 'base64');
      } catch {
        /* ignore */
      }
    }
    if (typeof j.image === 'string') {
      try {
        return Buffer.from(j.image, 'base64');
      } catch {
        /* ignore */
      }
    }
  }

  if (mode === 'ollama' || mode === 'auto') {
    const resp = j.response;
    if (typeof resp === 'string' && resp.length > 80) {
      try {
        const buf = Buffer.from(resp, 'base64');
        if (buf.length > 100) return buf;
      } catch {
        /* ignore */
      }
    }
    const msg = j.message as Record<string, unknown> | undefined;
    const arr = msg?.images ?? j.images;
    if (Array.isArray(arr) && typeof arr[0] === 'string') {
      try {
        return Buffer.from(arr[0], 'base64');
      } catch {
        /* ignore */
      }
    }
  }

  return null;
}

async function generateImageCli(
  params: ImageGenerationParams,
  config: NonNullable<ModelConfig['imageGeneratorConfig']>
): Promise<{ url: string; path: string; width: number; height: number }> {
  const appModule = await import('electron');
  const electronApp = appModule.app;

  const outputDir =
    params.outputDir ||
    join(electronApp.getPath('documents'), 'MyAgent', 'GeneratedImages');

  await fs.mkdir(outputDir, { recursive: true }).catch(() => {});

  if (!config.command?.trim()) {
    throw new Error('请填写「命令行程序」路径');
  }

  const outputFile = `${randomUUID()}.png`;
  const outputPath = join(outputDir, outputFile);

  const envVars: Record<string, string> = {
    ...(config.env || {}),
    MYAGENT_PROMPT: params.prompt ?? '',
    MYAGENT_OUTPUT_PATH: outputPath,
    MYAGENT_WIDTH: String(params.width ?? 512),
    MYAGENT_HEIGHT: String(params.height ?? 512),
  };

  const rawLines = (config.cliArgLines || '').split('\n');
  const argv = rawLines
    .map((line) => applyCliPlaceholders(line.trim(), params, outputPath))
    .filter((line) => line.length > 0);

  console.log('[生图 CLI]', config.command, argv.length ? argv : '(无 argv，仅用环境变量)');

  const useShell = process.platform === 'win32' && looksLikeWindowsExec(config.command);

  const proc = spawn(config.command, argv, {
    env: { ...process.env, ...envVars },
    cwd: electronApp.getPath('home'),
    shell: useShell,
  });

  const result = await new Promise<{ url: string; path: string; width: number; height: number }>(
    (resolve, reject) => {
      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error('生图命令超时（600 秒）'));
      }, 600000);

      let output = '';
      proc.stdout?.on('data', (data) => (output += data));
      proc.stderr?.on('data', (data) => (output += data));
      proc.on('close', (code) => {
        clearTimeout(timeout);
        void (async () => {
          try {
            await fs.access(outputPath);
          } catch {
            reject(
              new Error(
                `未在预期路径生成图片文件：${outputPath}\n子进程退出码=${code}\n输出：\n${output.slice(0, 4000)}`
              )
            );
            return;
          }

          if (code !== 0) {
            console.warn('[生图 CLI] 进程退出码非 0，但输出文件已存在:', code);
          }

          let stats: Promise<{ width: number; height: number }>;
          try {
            const sharp = require('sharp');
            stats = sharp(outputPath)
              .metadata()
              .then((m: { width?: number; height?: number }) => ({
                width: m.width ?? NaN,
                height: m.height ?? NaN,
              }));
          } catch {
            stats = Promise.resolve({ width: NaN, height: NaN });
          }

          stats
            .then(({ width, height }) =>
              resolve({
                url: `file://${outputPath}`,
                path: outputPath,
                width:
                  Number.isInteger(width) && width > 0 ? width : Number(params.width) || 512,
                height:
                  Number.isInteger(height) && height > 0 ? height : Number(params.height) || 512,
              })
            )
            .catch(() =>
              resolve({
                url: `file://${outputPath}`,
                path: outputPath,
                width: Number(params.width) || 512,
                height: Number(params.height) || 512,
              })
            );
        })();
      });
    }
  );

  return result;
}

function detectHttpFormat(
  endpoint: string,
  explicit?: ModelConfig['imageGeneratorConfig']
): 'sdwebui' | 'ollama' | 'raw' | 'auto' {
  const ex = explicit?.httpFormat;
  if (ex && ex !== 'auto') return ex;
  const u = endpoint.toLowerCase();
  if (u.includes('sdapi/v1/txt2img') || u.includes('txt2img')) return 'sdwebui';
  if (u.includes('/api/generate') && u.includes('11434')) return 'ollama';
  return 'auto';
}

async function generateImageHttp(
  params: ImageGenerationParams,
  config: NonNullable<ModelConfig['imageGeneratorConfig']>
): Promise<{ url: string; path: string; width: number; height: number }> {
  if (!config.endpoint?.trim()) {
    throw new Error('请配置生图 HTTP 接口 URL');
  }

  const appModule = await import('electron');
  const electronApp = appModule.app;

  const outputDir =
    params.outputDir ||
    join(electronApp.getPath('documents'), 'MyAgent', 'GeneratedImages');
  await fs.mkdir(outputDir, { recursive: true }).catch(() => {});

  const outputFile = `${randomUUID()}.png`;
  const outputPath = join(outputDir, outputFile);

  const axios = (await import('axios')).default;
  const endpoint = config.endpoint.trim();
  const mode = detectHttpFormat(endpoint, config);
  const ollamaModel =
    config.env?.OLLAMA_MODEL || config.env?.ollama_model || 'flux';

  let postBody: Record<string, unknown>;
  if (mode === 'sdwebui') {
    postBody = {
      prompt: params.prompt,
      negative_prompt: '',
      steps: 25,
      width: params.width || 512,
      height: params.height || 512,
      cfg_scale: 7,
      sampler_index: 'Euler a',
      n_iter: 1,
      batch_size: 1,
    };
  } else if (mode === 'ollama') {
    postBody = {
      model: ollamaModel,
      prompt: params.prompt ?? '',
      stream: false,
    };
  } else {
    postBody = {
      prompt: params.prompt,
      width: params.width,
      height: params.height,
    };
  }

  const res = await axios.post(endpoint, postBody, {
    headers: { 'Content-Type': 'application/json' },
    responseType: 'arraybuffer',
    timeout: 600000,
    validateStatus: (s) => s >= 200 && s < 300,
  });

  const buf = Buffer.from(res.data as ArrayBuffer);
  const ct = String(res.headers['content-type'] || '').toLowerCase();

  let imageBuf: Buffer | null = null;

  if (mode === 'raw' || ct.startsWith('image/')) {
    imageBuf = buf;
  }

  if (!imageBuf && (mode === 'sdwebui' || mode === 'ollama')) {
    try {
      const json = JSON.parse(buf.toString('utf8')) as unknown;
      imageBuf = extractImageBufferFromJson(json, mode);
    } catch {
      /* fallthrough */
    }
  }

  if (!imageBuf && mode === 'auto') {
    if (ct.includes('json') || (buf.length > 2 && buf[0] === 0x7b)) {
      try {
        const json = JSON.parse(buf.toString('utf8')) as unknown;
        imageBuf =
          extractImageBufferFromJson(json, 'sdwebui') ||
          extractImageBufferFromJson(json, 'ollama');
      } catch {
        /* ignore */
      }
    }
    if (!imageBuf && ct.startsWith('image/')) {
      imageBuf = buf;
    }
    if (!imageBuf && buf.length > 100 && buf.slice(0, 4).toString() === '\x89PNG') {
      imageBuf = buf;
    }
  }

  if (!imageBuf) {
    throw new Error(
      '无法从 HTTP 响应解析图片：请在设置中将「响应格式」设为 SD WebUI / Ollama / 原始图片，或检查接口是否返回 JSON(images[]) 或 PNG 二进制'
    );
  }

  await fs.writeFile(outputPath, imageBuf, { encoding: null });

  let stats: Promise<{ width: number; height: number }>;
  try {
    const sharp = require('sharp');
    stats = sharp(outputPath)
      .metadata()
      .then((m: { width?: number; height?: number }) => ({
        width: m.width ?? NaN,
        height: m.height ?? NaN,
      }));
  } catch {
    stats = Promise.resolve({ width: NaN, height: NaN });
  }

  return stats.then(({ width, height }) => ({
    url: `file://${outputPath}`,
    path: outputPath,
    width: Number.isInteger(width) && width > 0 ? width : Number(params.width) || 512,
    height: Number.isInteger(height) && height > 0 ? height : Number(params.height) || 512,
  }));
}

function isUsableImageConfig(
  c: ModelConfig['imageGeneratorConfig'] | undefined
): c is NonNullable<ModelConfig['imageGeneratorConfig']> {
  if (!c) return false;
  if (c.type === 'http') return Boolean(c.endpoint && String(c.endpoint).trim());
  return Boolean(c.command && String(c.command).trim());
}

ipcMain.handle('generate-image', async (_event, params: ImageGenerationParams) => {
  const config = params.imageGeneratorConfig;
  if (!isUsableImageConfig(config)) {
    throw new Error(
      '未配置图像生成工具：请在设置中添加模型并勾选「生图工具」，填写 CLI 或 HTTP；保存后重试。'
    );
  }

  try {
    if (config.type === 'http') {
      return await generateImageHttp(params, config);
    }
    return await generateImageCli(params, config);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('生成图片失败:', msg);
    throw new Error('生图失败: ' + msg);
  }
});

console.log('✅ 生图 IPC 处理器已注册');
