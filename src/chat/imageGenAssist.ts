import type React from 'react';
import type { FileInfo, ModelConfig } from '../types';
import {
  extractLaunchAppNames,
  extractGenerateImageCalls,
  stripRedundantAssistantImagePromptBlocks,
  stripGenerateImageArtifactsForDisplay,
} from '../utils/toolCalls';
import { inferImageCountFromText, type ImageIntent } from '../utils/imageIntentPlanner';
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

/** 云端 HTTPS API（方舟/阿里云/通用 SaaS）不削减像素；仅 CLI、http:// 本地/内网减负 */
function shouldClampDimensionsForHeavyLocalGen(c: NonNullable<ModelConfig['imageGeneratorConfig']>): boolean {
  if (c.type === 'cli') return true;
  const ep = (c.endpoint || '').trim();
  if (!ep) return false;
  return !/^https:\/\//i.test(ep);
}

function clampDimensionsForLocalImageGen(width?: number, height?: number, maxSide = 1024): { width?: number; height?: number } {
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height)) {
    return { width, height };
  }
  if (width <= 0 || height <= 0) return { width, height };
  const m = Math.max(width, height);
  if (m <= maxSide) return { width: Math.round(width), height: Math.round(height) };
  const scale = maxSide / m;
  return {
    width: Math.max(256, Math.round(width * scale)),
    height: Math.max(256, Math.round(height * scale)),
  };
}

export function imageReferencePathsFromFiles(files?: FileInfo[]): string[] {
  return (files ?? [])
    .filter((f) => f.type?.startsWith('image/') && f.path)
    .map((f) => f.path);
}

export async function createDocumentArtifactsFromMarkdown(
  content: string,
  formats: Array<'md' | 'docx'>,
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
  }
  return files;
}

function inferRequestedImageCount(prompt: string, explicit?: number, context?: string): number | undefined {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return Math.max(1, Math.min(12, Math.round(explicit)));
  }
  const text = [context, prompt].filter(Boolean).join('\n');
  return inferImageCountFromText(text);
}

/**
 * @param options.forLocalCli — 本地 CLI/SD 主干为英文时，多图说明用英文后缀，避免中文污染 MYAGENT_PROMPT。
 */
function enhancePromptForMultiImage(
  prompt: string,
  count?: number,
  options?: { forLocalCli?: boolean }
): string {
  if (!count || count <= 1) return prompt;
  const p = prompt.trim();
  const isLandscape =
    /风景|景观|山|海|湖|森林|草原|城市|建筑|夜景|日出|日落|天空|云|河流|峡谷|landscape|scenery|mountain|ocean|lake|forest|city|architecture|sunset|sunrise|sky|cloud|river|valley/i.test(p);

  if (options?.forLocalCli) {
    const diversityAxis = isLandscape
      ? 'Make each image clearly different in subject matter, composition, light, weather, color, and camera angle, while keeping consistent overall quality.'
      : 'Make each image clearly different in subject pose, framing, outfit or color palette, action, and viewpoint, while keeping consistent quality and a polished photographic look.';
    const diversityHint =
      `Generate exactly ${count} separate full images—one finished image per generation, not a grid, collage, or contact sheet. ${diversityAxis}`;
    return `${p}\n${diversityHint}`;
  }

  const diversityAxisZh = isLandscape
    ? '主体景观、构图、光线、天气、色彩、镜头角度需要明显不同，但整体影像质量保持统一。'
    : '主体、构图、动作、服装款式、配色、镜头角度需要明显不同，但整体质量和商业摄影风格保持统一。';
  const diversityHintZh =
    `本次需要一次性生成 ${count} 张成品图。每张都必须是独立完整图片，不能拼成九宫格或合照；` +
    diversityAxisZh;
  return `${p}\n${diversityHintZh}`;
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
  return model?.imageGeneratorConfig?.type === 'cli';
}

function shouldUseToolPromptForCli(
  planned: ImageIntent | undefined,
  toolPrompt: string,
  model: ModelConfig | undefined
): boolean {
  if (!planned?.shouldGenerate || planned.inheritStyle || !isCliImageGenerator(model)) return false;
  const p = toolPrompt.trim();
  if (!p) return false;
  if (containsCjk(p)) return false;
  return countAsciiWords(p) >= 8;
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
  opts?: { imageGenHooks?: ImageGenProgressHooks; referenceImages?: string[]; userPromptContext?: string; plannedIntent?: ImageIntent; shouldCancel?: () => boolean }
): Promise<{ content: string; files?: FileInfo[] }> {
  let text = responseContent;

  const launches = extractLaunchAppNames(text);
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
  const imgGenModel = resolveImageGeneratorModel();
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
      text = text.replace(
        raw,
        `\n*[系统提示: 未配置生图——请在「设置 → 模型配置」中添加模型，勾选「生图工具」并填写 CLI 可执行文件或 HTTP 生图接口]*\n`
      );
      continue;
    }
    const planned = opts?.plannedIntent;
    const useToolPromptForCli = shouldUseToolPromptForCli(planned, prompt, imgGenModel);
    const shouldUseCurrentTurnPrompt =
      planned?.shouldGenerate &&
      !planned.inheritStyle &&
      planned.prompt.trim().length > 0 &&
      !useToolPromptForCli;
    toGenerate.push({
      prompt: shouldUseCurrentTurnPrompt ? planned.prompt : prompt,
      width: shouldUseCurrentTurnPrompt ? undefined : width,
      height: shouldUseCurrentTurnPrompt ? undefined : height,
      count: count ?? planned?.count,
      raw,
      isolatedPrompt: shouldUseCurrentTurnPrompt,
    });
  }

  const planned = opts?.plannedIntent;
  if (toGenerate.length === 0 && imgGenModel?.imageGeneratorConfig && planned?.shouldGenerate) {
    toGenerate.push({
      prompt: planned?.prompt?.trim() || opts?.userPromptContext?.trim() || text.trim(),
      count: planned?.count ?? inferRequestedImageCount(text, undefined, opts?.userPromptContext),
      raw: '',
      isolatedPrompt: !planned.inheritStyle,
    });
  }

  const expectedCounts = toGenerate.map((g) =>
    inferRequestedImageCount(g.prompt, g.count, opts?.userPromptContext) ?? 1
  );
  const expectedTotal = expectedCounts.reduce((sum, n) => sum + Math.max(1, n), 0);
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
            : m.apiKey?.trim()
              ? { apiKey: m.apiKey.trim() }
              : {}),
        };
        let widthOut = width;
        let heightOut = height;
        if (shouldClampDimensionsForHeavyLocalGen(cfg)) {
          const clipped = clampDimensionsForLocalImageGen(width, height);
          widthOut = clipped.width;
          heightOut = clipped.height;
        }
        const requestedCount = expectedCounts[i];
        const forCli = isCliImageGenerator(m);
        const promptForCli = await rewritePromptForLocalCliIfNeeded(
          prompt,
          activeModel,
          m,
          requestedCount > 1 ? requestedCount : undefined
        );
        const imgs = await window.electron.generateImage(
          {
            prompt: enhancePromptForMultiImage(promptForCli, requestedCount, { forLocalCli: forCli }),
            width: widthOut,
            height: heightOut,
            count: requestedCount,
            referenceImages: opts?.referenceImages,
            modelId: m.id,
            imageGeneratorConfig,
            isolatedPrompt,
          },
          {
            onImage: ({ image, index, total }) => {
              hooks?.onImage?.({ image, index, total });
            },
          }
        );
        if (opts?.shouldCancel?.()) break;
        for (const img of imgs) {
          generatedFiles.push(img);
        }
        expectedDone += Math.max(1, imgs.length || requestedCount || 1);
        hooks?.onEachDone?.({ done: Math.min(expectedDone, expectedTotal), total: expectedTotal });
        if (raw) text = text.replace(raw, '');
      } catch (e: unknown) {
        const msg = formatImageGenUserError(e instanceof Error ? e.message : String(e));
        text = text.replace(raw, `\n*[系统提示: 图片生成失败 - ${msg}]*\n`);
      }
      await yieldToMain();
    }
  } finally {
    if (toGenerate.length > 0) {
      hooks?.onDone?.();
    }
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
  if (generatedFiles.length > 0 && isImageRefusalText(text)) {
    text = '';
  }

  return { content: text, files };
}
