import type React from 'react';
import type { FileInfo, ModelConfig } from '../types';
import {
  extractLaunchAppNames,
  extractGenerateImageCalls,
  stripRedundantAssistantImagePromptBlocks,
  stripGenerateImageArtifactsForDisplay,
} from '../utils/toolCalls';
import { inferImageCountFromText, imageRequestIsDiscussion, imageRequestIsDataVisualization, type ImageIntent } from '../utils/imageIntentPlanner';
import { useModelStore } from '../store/modelStore';

async function yieldToMain(): Promise<void> {
  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(() => resolve());
    else setTimeout(() => resolve(), 0);
  });
}

export type ImageGenProgressHooks = {
  onBegin?: (p: { total: number }) => void;
  onEachStart?: (p: { current: number; total: number }) => void;
  onEachDone?: (p: { done: number; total: number }) => void;
  onImage?: (p: {
    image: { url: string; path: string; width: number; height: number };
    index: number;
    total: number;
  }) => void;
  onDone?: () => void;
};

export type AssistantPostProcessResult = {
  content: string;
  files?: FileInfo[];
  /** Keep execution failures distinct from readable assistant text. */
  taskError?: string;
};

/**
 * 检测模型回复是否为「拒绝生图/绘图」话术（中英文）。
 * 用于：图已成功生成时，清除这种与实际行为矛盾的文本。
 * 策略：只要同时含「拒绝类语义」和「画图/生图类语义」即判定为拒绝，
 *       覆盖"根据系统设定我被禁止进行AI生图""无法绘制人体艺术图"等多种表述。
 */
function isImageRefusalText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  /** 拒绝话术通常较短（<300字）；长说明性回复不可能是纯拒绝 */
  if (t.length > 300) return false;

  /** —— 中文：拒绝类动词词根 —— */
  const zhRefusal = /(不能|无法|不具备|没法|没有能力|不会|被禁止|禁止|无法使用|不支持|无权|拒绝|根据系统设定|系统设定|出于安全|内容政策)/.test(t);
  /** —— 中文：画图/生图动作词根（宽匹配，含"AI 生图""人体艺术图""绘制图片"等） —— */
  const zhImageAction = /(生图|绘图|画图|生成图|绘制|画出|为你画|为您.*?(画|绘|制作)|制作.*?(图|图片|图像)|AI.*?(生图|画图|绘图|生成图)|人体艺术图|插画|画作|图片|图像)/.test(t);
  if (zhRefusal && zhImageAction) return true;

  /** —— 中文直白型（不依赖双段命中） —— */
  if (/(不能|无法|被禁止).{0,12}(为您|帮你|为你)?.{0,4}(生成|画|绘|制作|创建).{0,8}(图|图片|图像)/.test(t)) return true;
  if (/我.*(不具备|没有).*(生图|绘图|生成图片|图像生成|绘图能力)/.test(t)) return true;

  /** —— 英文拒绝模式 —— */
  const enRefusal = /\b(can'?t|cannot|unable|not able|don'?t have|do not have|am not|prohibited|not (?:allowed|supported|permitted)|refuse|decline|against my (?:programming|guidelines|policy))\b/i.test(t);
  const enImageAction = /\b(generate|create|draw|produce|make)\b.{0,20}\b(images?|pictures?|art|illustrations?|paintings?)\b/i.test(t)
    || /\bAI image\b/i.test(t);
  if (enRefusal && enImageAction) return true;

  return false;
}

/** 剥离 Electron IPC / 多层 Error 前缀，仅在气泡中展示可读原因 */
function formatImageGenUserError(raw: string): string {
  let m = raw.replace(/^Error invoking remote method\s+'[^']+':\s*/i, '').trim();
  m = m.replace(/^Error:\s*/i, '').trim();
  while (/^生图失败:\s*/i.test(m)) {
    m = m.replace(/^生图失败:\s*/i, '').trim();
  }
  while (/^Error:\s*/i.test(m)) {
    m = m.replace(/^Error:\s*/i, '').trim();
  }
  const readable = m || raw;
  return readable.length > 1200 ? `${readable.slice(0, 1200)}\n\n[错误信息过长，已截断]` : readable;
}

export function imageReferencePathsFromFiles(files?: FileInfo[]): string[] {
  return (files ?? [])
    .filter((f) => f.type?.startsWith('image/') && f.path)
    .map((f) => f.path);
}

export async function createDocumentArtifactsFromMarkdown(
  content: string,
  formats: import('../types/document').DocumentFormat[],
  baseName: string
): Promise<FileInfo[]> {
  const files: FileInfo[] = [];
  for (const format of formats) {
    const r = await window.electron.createDocumentArtifact({
      format,
      content,
      defaultBaseName: baseName,
    });
    if (r.ok && r.file) files.push(r.file);
    else throw new Error(r.error || `无法生成 ${format.toUpperCase()} 文件`);
  }
  return files;
}

function containsCjk(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

function countAsciiWords(text: string): number {
  return (text.match(/[A-Za-z][A-Za-z0-9'-]*/g) || []).length;
}

function cleanLocalCliPromptRewrite(raw: string): string {
  const toolCalls = extractGenerateImageCalls(raw, { allowBarePromptJson: true });
  const toolPrompt = toolCalls.find((x) => x.prompt.trim())?.prompt?.trim();
  const text = (toolPrompt || stripGenerateImageArtifactsForDisplay(raw))
    .replace(/\r\n/g, '\n')
    .replace(/^```(?:text|txt|json|markdown)?\s*/i, '')
    .replace(/```$/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(?:prompt|english prompt|final prompt|output)\s*[:：]\s*$/i.test(line));
  const compact = lines.join(' ').replace(/\s+/g, ' ').trim();
  return compact.replace(/^(?:prompt|english prompt|final prompt|output)\s*[:：]\s*/i, '').trim();
}

function isCliImageGenerator(model: ModelConfig | undefined): boolean {
  const cfg = model?.imageGeneratorConfig;
  return cfg?.type === 'cli' && (cfg.promptLanguage === 'en' || (cfg.promptLanguage !== 'auto' && Boolean(cfg.env?.MYAGENT_SD_MODEL || /sd15|sdxl|diffusers/i.test(cfg.cliArgLines || ''))));
}

async function rewritePromptForLocalCliIfNeeded(
  prompt: string,
  activeModel: ModelConfig,
  imgGenModel: ModelConfig | undefined,
  multiImageBatch?: number
): Promise<string> {
  const p = prompt.trim();
  if (!p || !isCliImageGenerator(imgGenModel) || !containsCjk(p)) return prompt;

  const batchNote =
    typeof multiImageBatch === 'number' &&
    Number.isFinite(multiImageBatch) &&
    multiImageBatch > 1
      ? `\n\n[Context: ${multiImageBatch} separate images will be produced from this description in sequence. Write ONE compact English SD prompt that states the shared subject and aesthetic; phrasing should allow natural variation across runs (different pose, angle, or detail). Output English only, single paragraph.]`
      : '';

  try {
    const response = await window.electron.callModel(
      [
        {
          id: `sd-prompt-sys-${Date.now()}`,
          role: 'system',
          content:
            'You are a strict prompt translation engine for a local Stable Diffusion / SDXL image generator. Translate and rewrite the user image request into ONE concise English image prompt. Output ONLY the English prompt text. No JSON, no XML, no Markdown, no quotes, no explanations, no thinking text, no Chinese characters. Preserve the requested subject exactly; do not add people unless the user asked for people. Add useful style, composition, lighting, camera, and quality terms.',
          timestamp: Date.now(),
          model: 'myagent-sd-prompt-rewrite',
        },
        {
          id: `sd-prompt-user-${Date.now()}`,
          role: 'user',
          content: p + batchNote,
          timestamp: Date.now(),
          model: activeModel.name,
        },
      ],
      { ...activeModel, maxTokens: Math.min(activeModel.maxTokens || 1024, 512) },
      { locale: 'en' }
    );
    const rewritten = cleanLocalCliPromptRewrite(response.content || '');
    if (rewritten && !containsCjk(rewritten) && countAsciiWords(rewritten) >= 6) {
      console.info('[生图 CLI] 中文 prompt 已改写为英文 SD prompt', {
        originalPreview: p.slice(0, 240),
        rewrittenPreview: rewritten.slice(0, 500),
      });
      return rewritten;
    }
    console.warn('[生图 CLI] 中文 prompt 英文化结果不可用', {
      originalPreview: p.slice(0, 240),
      responsePreview: String(response.content || '').slice(0, 800),
      rewrittenPreview: rewritten.slice(0, 500),
    });
  } catch (e) {
    console.warn('[生图 CLI] 中文 prompt 英文化失败', e);
  }
  throw new Error('本地 CLI 生图需要英文 prompt，但当前本地对话模型没有返回可用英文提示词；已中止，避免把中文 prompt 直接送入 SD/SDXL。');
}

export async function postProcessAssistantContent(
  responseContent: string,
  activeModel: ModelConfig,
  imageIndexBase: number,
  setInlineImageIndex: React.Dispatch<React.SetStateAction<number>>,
  opts?: { imageGenHooks?: ImageGenProgressHooks; referenceImages?: string[]; userPromptContext?: string; plannedIntent?: ImageIntent; requestId?: string; shouldCancel?: () => boolean }
): Promise<AssistantPostProcessResult> {
  let text = responseContent;
  const failures: string[] = [];

  const launches = /打开|启动|运行|\b(?:open|launch|start)\b/i.test(opts?.userPromptContext || '') ? extractLaunchAppNames(text) : [];
  for (const { name, raw } of launches) {
    try {
      await window.electron.launchApp(name);
      text = text.replace(raw, `\n*[系统提示: 已尝试启动应用 ${name}]*\n`);
    } catch {
      text = text.replace(raw, `\n*[系统提示: 启动应用 ${name} 失败]*\n`);
    }
  }

  const resolveImageGeneratorModel = (): ModelConfig | undefined => {
    /** 生图模型独立于对话模型：优先用户选定的，否则自动找第一个可用 */
    return useModelStore.getState().getEffectiveImageGenModel();
  };
  if (opts?.plannedIntent?.shouldGenerate === false || opts?.shouldCancel?.() || imageRequestIsDiscussion(opts?.userPromptContext || '') || imageRequestIsDataVisualization(opts?.userPromptContext || '')) return { content: stripGenerateImageArtifactsForDisplay(text) };
  const imgGenModel = resolveImageGeneratorModel();
  if (!imgGenModel && opts?.plannedIntent?.shouldGenerate) return { content: '请先在设置中添加图片服务，然后重试。', taskError: '未配置图片服务' };
  const hooks = opts?.imageGenHooks;
  const allowBarePromptJson =
    Boolean(opts?.plannedIntent?.shouldGenerate) ||
    Boolean(
      imgGenModel?.imageGeneratorConfig &&
        /^\s*\{[\s\S]*"prompt"\s*:/.test(text) &&
        /"(?:count|width|height|n|num_images|max_images)"\s*:/.test(text)
    );
  const imageCalls = extractGenerateImageCalls(text, {
    allowBarePromptJson,
  });

  type GenItem = { prompt: string; width?: number; height?: number; count?: number; raw: string; isolatedPrompt?: boolean };
  const toGenerate: GenItem[] = [];
  for (const match of imageCalls) {
    const { prompt, width, height, count, raw } = match;
    if (!imgGenModel?.imageGeneratorConfig) {
      failures.push('未配置图片服务');
      text = text.replace(
        raw,
        `\n*[系统提示: 未配置生图——请在「设置 → 模型配置」中添加模型，勾选「生图工具」并填写 CLI 可执行文件或 HTTP 生图接口]*\n`
      );
      continue;
    }
    toGenerate.push({ prompt, width, height, count, raw, isolatedPrompt: !opts?.plannedIntent?.inheritStyle });
  }

  // Only execute a structured model tool call. Keywords must never turn a
  // clarification, refusal or explanatory answer into a paid generation.
  const userCount = inferImageCountFromText(opts?.userPromptContext || '');
  const expectedCounts = toGenerate.map((g) =>
    (toGenerate.length === 1 ? userCount : undefined) ?? g.count ?? 1
  );
  const expectedTotal = expectedCounts.reduce((sum, n) => sum + Math.max(1, n), 0);
  if (userCount && toGenerate.length > 1 && expectedTotal !== userCount) return { content: `图片计划数量与要求的 ${userCount} 张不一致，尚未执行，请重试。`, taskError: '图片计划数量与要求不一致' };
  if (expectedTotal > 12) return { content: '单次最多生成 12 张图片，请减少数量或分批生成。', taskError: '图片计划超出单次 12 张上限' };
  const generatedFiles: Array<{ path: string; url: string; width: number; height: number; size?: number }> = [];
  if (toGenerate.length > 0) {
    hooks?.onBegin?.({ total: expectedTotal });
  }
  try {
    let expectedDone = 0;
    for (let i = 0; i < toGenerate.length; i++) {
      if (opts?.shouldCancel?.()) break;
      const { prompt, width, height, raw, isolatedPrompt } = toGenerate[i];
      hooks?.onEachStart?.({
        current: Math.min(expectedDone + 1, expectedTotal),
        total: expectedTotal,
      });
      try {
        const m = imgGenModel!;
        const cfg = m.imageGeneratorConfig!;
        const imageGeneratorConfig = {
          ...cfg,
          /** 生图密钥为空时回退同一模型顶部 API Key（用户常只填一处） */
          ...(cfg.apiKey?.trim()
            ? {}
            : cfg.apiKeySource !== 'independent' && m.apiKey?.trim()
              ? { apiKey: m.apiKey.trim() }
              : {}),
        };
        const requestedCount = expectedCounts[i];
        const promptForCli = await rewritePromptForLocalCliIfNeeded(
          prompt,
          activeModel,
          m,
          requestedCount > 1 ? requestedCount : undefined
        );
        if (opts?.shouldCancel?.()) break;
        const imgs = await window.electron.generateImage(
          {
            streamRequestId: opts?.requestId,
            ...(/透明背景|背景透明|去[除掉]?背景|transparent background|remove.*background/i.test(opts?.userPromptContext || '') ? { background: 'transparent' as const } : {}),
            prompt: promptForCli,
            width,
            height,
            count: requestedCount,
            referenceImages: opts?.referenceImages,
            modelId: m.id,
            imageGeneratorConfig,
            isolatedPrompt,
          },
          {
            onImage: ({ image, index, total }) => {
              if (opts?.shouldCancel?.()) return;
              if (!generatedFiles.some(f => f.path === image.path)) generatedFiles.push(image);
              hooks?.onImage?.({ image, index, total });
            },
          }
        );
        if (opts?.shouldCancel?.()) break;
        for (const img of imgs) {
          if (!generatedFiles.some(f => f.path === img.path)) generatedFiles.push(img);
        }
        expectedDone += Math.max(1, imgs.length || requestedCount || 1);
        hooks?.onEachDone?.({ done: Math.min(expectedDone, expectedTotal), total: expectedTotal });
        if (raw) text = text.replace(raw, '');
      } catch (e: unknown) {
        if (opts?.shouldCancel?.()) break;
        const msg = formatImageGenUserError(e instanceof Error ? e.message : String(e));
        failures.push(msg);
        text = text.replace(raw, `\n*[系统提示: 图片生成失败 - ${msg}]*\n`);
      }
      await yieldToMain();
    }
  } finally {
    if (toGenerate.length > 0) {
      hooks?.onDone?.();
    }
  }

  if (opts?.shouldCancel?.()) text = '已停止生成，已完成的图片已保留。';
  else if (generatedFiles.length < expectedTotal) {
    const incomplete = `图片仅完成 ${generatedFiles.length}/${expectedTotal} 张`;
    if (!failures.length) failures.push(incomplete);
    text += generatedFiles.length > 0
      ? `\n\n已完成 ${generatedFiles.length}/${expectedTotal} 张图片，未完成部分可重新生成。`
      : failures.length === 1 && failures[0] === incomplete ? `\n\n图片生成失败：未收到有效图片（0/${expectedTotal}）。` : '';
  }

  let files: FileInfo[] | undefined;
  if (generatedFiles.length > 0) {
    /** 主进程写盘时已带回 size，渲染层无需再触 fs */
    const fileInfos: FileInfo[] = generatedFiles.map((f, i) => ({
      name: `generated_${imageIndexBase + i + 1}.png`,
      path: f.path,
      type: 'image/png',
      size: f.size ?? 0,
    }));
    setInlineImageIndex((prev) => prev + generatedFiles.length);
    files = fileInfos;
  }

  if (toGenerate.length > 0) {
    text = stripRedundantAssistantImagePromptBlocks(
      text,
      toGenerate.map((g) => g.prompt)
    );
  }

  text = stripGenerateImageArtifactsForDisplay(text);

  /** 修复言行不一：若实际已成功生成图，但模型文本里含「不能生图」类拒绝话术，则清除 */
  if (generatedFiles.length >= expectedTotal && expectedTotal > 0 && isImageRefusalText(text)) {
    text = '';
  }

  return { content: text, files, ...(!opts?.shouldCancel?.() && failures.length ? { taskError: [...new Set(failures)].join('；') } : {}) };
}
