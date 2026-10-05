import { imageTaskContext, checkImageTask } from './task';
import { spawn } from 'child_process';
import { join } from 'path';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import type { ModelConfig, ImageGenerationParams } from '../../../src/types';
import { MAX_CLI_COMBINED_LOG_CHARS, VENDOR_IMAGE_COUNT_LIMITS } from '../../constants';
import { IMAGE_GEN_TIMEOUT_MS } from './queue';
import { imgGenDebug } from './debug';
import { readImageSizeWithFallback, resolveImageOutputDir } from './buffers';
import type {
  CliGeneratedImage,
  GeneratedImage,
  ImageGeneratedCallback,
} from './adapters/types';

/** CLI 子进程 stdout/stderr 合并上限，避免海量日志撑爆主进程内存导致假死 */
function appendCappedCliLog(acc: string, chunk: Buffer | string): string {
  if (acc.length >= MAX_CLI_COMBINED_LOG_CHARS) return acc;
  const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  const room = MAX_CLI_COMBINED_LOG_CHARS - acc.length;
  return acc + (s.length <= room ? s : `${s.slice(0, room)}\n…[CLI 输出已截断]\n`);
}

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
  const count = String(params.count ?? 1);
  const steps = String((params as { steps?: number }).steps ?? process.env.MYAGENT_SD_STEPS ?? 20);
  const p = params.prompt ?? '';
  return line
    .replace(/\{\{prompt\}\}/g, p)
    .replace(/\{\{outputPath\}\}/g, outputPath)
    .replace(/\{\{width\}\}/g, w)
    .replace(/\{\{height\}\}/g, h)
    .replace(/\{\{count\}\}/g, count)
    .replace(/\{\{steps\}\}/g, steps);
}

/**
 * 单次 CLI 调用：仅校验 `outputPath` 这一张图。
 * 多图场景由上层按 `count` 顺序多次调用（每次独立输出路径、MYAGENT_COUNT=1），
 * 兼容「只往 MYAGENT_OUTPUT_PATH 写一张」的本地脚本。
 */
async function generateImageCliOneShot(
  params: ImageGenerationParams,
  config: NonNullable<ModelConfig['imageGeneratorConfig']>,
  outputPath: string,
  batch?: { index: number; total: number }
): Promise<CliGeneratedImage> {
  checkImageTask();
  const exe = config.command?.trim();
  if (!exe) {
    throw new Error('请填写「命令行程序」路径');
  }

  const appModule = await import('electron');
  const electronApp = appModule.app;

  const runCount = params.count ?? 1;
  const envVars: Record<string, string> = {
    ...(config.env || {}),
    MYAGENT_PROMPT: params.prompt ?? '',
    MYAGENT_OUTPUT_PATH: outputPath,
    MYAGENT_WIDTH: String(params.width ?? 512),
    MYAGENT_HEIGHT: String(params.height ?? 512),
    MYAGENT_COUNT: String(runCount),
    MYAGENT_REFERENCE_IMAGES: JSON.stringify(params.referenceImages ?? []),
    MYAGENT_SD_ISOLATED_PROMPT: params.isolatedPrompt ? '1' : '0',
  };
  if (batch && batch.total > 1) {
    envVars.MYAGENT_IMAGE_INDEX = String(batch.index);
    envVars.MYAGENT_IMAGE_TOTAL = String(batch.total);
  }

  const rawLines = (config.cliArgLines || '').split('\n');
  const argv = rawLines
    .map((line) => applyCliPlaceholders(line.trim(), params, outputPath))
    .filter((line) => line.length > 0);

  imgGenDebug('[生图 CLI] 启动', {
    command: exe,
    argv,
    isolatedPrompt: Boolean(params.isolatedPrompt),
    promptPreview: String(params.prompt ?? '').slice(0, 500),
    width: params.width ?? 512,
    height: params.height ?? 512,
    count: runCount,
    model: envVars.MYAGENT_SD_MODEL,
    outputPath,
    ...(batch && batch.total > 1
      ? { batchIndex: batch.index, batchTotal: batch.total }
      : {}),
  });

  const useShell = process.platform === 'win32' && looksLikeWindowsExec(exe);

  checkImageTask();
  const signal = imageTaskContext.getStore();
  const proc = spawn(exe, argv, {
    env: { ...process.env, ...envVars },
    cwd: electronApp.getPath('home'),
    shell: useShell,
  });

  return await new Promise<CliGeneratedImage>((resolve, reject) => {
    let settled = false; let closed = false; let stopReason: Error | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined; let stopDeadline: ReturnType<typeof setTimeout> | undefined;
    let output = '';
    const cleanup = () => { clearTimeout(timeout); if (forceKill) clearTimeout(forceKill); if (stopDeadline) clearTimeout(stopDeadline); signal?.removeEventListener('abort', abort); };
    const fail = async (error: unknown) => {
      if (settled) return; settled = true; cleanup();
      await fs.unlink(outputPath).catch(() => {});
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const stop = (reason: Error) => {
      if (settled || stopReason) return; stopReason = reason;
      if (closed) { void fail(reason); return; }
      proc.kill('SIGTERM');
      forceKill = setTimeout(() => { proc.kill('SIGKILL'); }, 1000); forceKill.unref();
      // A descendant retaining stdout can delay close even after the direct child dies.
      stopDeadline = setTimeout(() => { void fail(reason); }, 2500); stopDeadline.unref();
    };
    const abort = () => stop(signal?.reason instanceof Error ? signal.reason : new Error('已停止生图 / Image generation stopped'));
    const timeout = setTimeout(() => stop(new Error(`生图命令超时（${Math.max(1, Math.round(IMAGE_GEN_TIMEOUT_MS / 60_000))} 分钟）`)), IMAGE_GEN_TIMEOUT_MS);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    proc.on('error', error => { void fail(error); });
    proc.stdout?.on('data', data => { output = appendCappedCliLog(output, data); });
    proc.stderr?.on('data', data => { output = appendCappedCliLog(output, data); });
    proc.on('close', code => {
      closed = true;
      void (async () => {
        if (settled) { if (stopReason) await fs.unlink(outputPath).catch(() => {}); return; }
        try {
          if (stopReason || signal?.aborted) throw stopReason ?? signal?.reason ?? new Error('已停止生图');
          try { await fs.access(outputPath); }
          catch { throw new Error(`未在预期路径生成图片文件：${outputPath}\n子进程退出码=${code}\n输出：\n${output.slice(0, 4000)}`); }
          const { width, height } = await readImageSizeWithFallback(outputPath, params);
          if (stopReason || signal?.aborted) throw stopReason ?? signal?.reason ?? new Error('已停止生图');
          const size = (await fs.stat(outputPath)).size;
          if (stopReason || signal?.aborted) throw stopReason ?? signal?.reason ?? new Error('已停止生图');
          if (code !== 0) console.warn('[生图 CLI] 进程退出码非 0，但有效图片已生成:', code);
          if (!settled) { settled = true; cleanup(); resolve({ url: `file://${outputPath}`, path: outputPath, width, height, size }); }
        } catch (error) { await fail(error); }
      })();
    });
  });
}

async function generateImageCli(
  params: ImageGenerationParams,
  config: NonNullable<ModelConfig['imageGeneratorConfig']>,
  onImage?: ImageGeneratedCallback
): Promise<GeneratedImage[]> {
  const outputDir = await resolveImageOutputDir(params);

  if (!config.command?.trim()) {
    throw new Error('请填写「命令行程序」路径');
  }

  const rawN = params.count;
  const requested =
    typeof rawN === 'number' && Number.isFinite(rawN) && rawN > 0 ? Math.round(rawN) : 1;
  const n = Math.max(1, Math.min(VENDOR_IMAGE_COUNT_LIMITS.cli, requested));

  const results: CliGeneratedImage[] = [];
  if (n <= 1) {
    const outputPath = join(outputDir, `${randomUUID()}.png`);
    const img = await generateImageCliOneShot(params, config, outputPath);
    results.push(img);
    onImage?.(img, 1, 1);
    return results;
  }

  for (let i = 0; i < n; i++) {
    checkImageTask();
    const outputPath = join(outputDir, `${randomUUID()}.png`);
    const perParams: ImageGenerationParams = { ...params, count: 1 };
    const img = await generateImageCliOneShot(perParams, config, outputPath, {
      index: i + 1,
      total: n,
    });
    results.push(img);
    onImage?.(img, i + 1, n);
  }
  return results;
}

export {
  generateImageCli,
  generateImageCliOneShot,
  applyCliPlaceholders,
  looksLikeWindowsExec,
  appendCappedCliLog,
};
