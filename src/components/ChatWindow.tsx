import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useLayoutEffect,
  useMemo,
} from 'react';
import { useChatStore } from '../store/chatStore';
import { useModelStore, modelHasUsableImageGenerator } from '../store/modelStore';
import { useWebSearchStore } from '../store/webSearchStore';
import { useSettingStore } from '../store/settingStore';
import { useParticleStore } from '../store/particleStore';
import { useI18n } from '../hooks/useI18n';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useKnowledgeStore } from '../store/knowledgeStore';
import { Message, ChatSession, FileInfo, ModelConfig, WebSearchProvider } from '../types';
import { FiPaperclip, FiFile, FiImage, FiSquare, FiDownload, FiGlobe, FiLoader, FiMic, FiTrash2, FiCheckSquare, FiX } from 'react-icons/fi';
import MessageItem, { ConversationImageGalleryModal } from './MessageItem';
import {
  buildConversationImageGallery,
  findConversationGalleryIndex,
} from '@/utils/conversationImageGallery';
import ModelSelector from './ModelSelector';
import { IosSwitch } from './IosSwitch';
import { getWebSearchQueryIfTriggered } from '../utils/webSearchTrigger';
import {
  extractLaunchAppNames,
  extractGenerateImageCalls,
  stripRedundantAssistantImagePromptBlocks,
  stripGenerateImageArtifactsForDisplay,
} from '../utils/toolCalls';
import { useWebSpeechDictation, type SpeechApiTranscribeConfig } from '@/hooks/useWebSpeechDictation';
import { useVoiceWake } from '@/hooks/useVoiceWake';
import { useMainWindowFocused } from '@/hooks/useMainWindowFocused';
import { useSystemTtsAvailable } from '@/hooks/useSystemTtsAvailable';
import { speakText } from '@/utils/speakText';
import { StreamingSpeechReader } from '@/utils/streamingSpeech';
import { sessionToHtml, sessionToMarkdown } from '../utils/exportChat';
import { canUseSseStream, effectiveWebEnabled } from '../utils/chatModelPolicy';
import { enrichMessagesForModel } from '../utils/enrichMessagesForModel';
import { sanitizeMessagesForModel } from '../utils/sanitizeMessagesForModel';
import { isAgentToolsBuildEnabled } from '@/agent/buildFlags';
import { runAgentLoop } from '@/agent/agentRunner';
import { looksLikeLocalFileAgentRequest, looksLikeLocalImageFindRequest } from '@/agent/localFileIntent';
import { looksLikeWebBrowseRequest } from '@/agent/webBrowseIntent';
import {
  agentBrowserClose,
  agentBrowserEval,
  agentBrowserOpen,
  agentBrowserRead,
} from '@/agent/browser/agentBrowserController';
import AgentBrowserPanel from './AgentBrowserPanel';
import { t as tUi } from '../i18n/ui';
import type { Locale } from '../i18n/types';
import { inferImageCountFromText, planImageIntent, type ImageIntent } from '../utils/imageIntentPlanner';
import {
  documentArtifactBaseName,
  documentArtifactBaseNameFromContent,
  documentExportFormatsFromHint,
  inferDocumentExportHint,
} from '../utils/documentExportIntent';
import { flushZustandFilePersist } from '../utils/zustandFileStorage';
import {
  estimateSessionChars,
  resolveContextProgressFullChars,
} from '../utils/contextBudget';
import { resolveContextSoftLimitChars } from '../utils/inferContextWindow';
import { ensureContextBeforeSend } from '../chat/ensureContextBeforeSend';
import {
  estimateInjectedPayloadOverheadChars,
  messagesExceedSanitizeLimit,
} from '../chat/payloadBoundary';
import {
  addFullTextBypassIfNeeded,
  resolveInjectExtras,
  tryClaimSessionSend,
} from '../chat/sendPipeline';

function userQueryTextForRag(m: Message): string {
  const t = (m.content || '').trim();
  if (t && t !== '（附件）') return t;
  if (m.files?.length) return m.files.map((f) => f.name).join(' ');
  return '';
}

/** 多次连续生图之间让渲染进程有机会打一帧 UI，减轻整窗卡顿观感 */
async function yieldToMain(): Promise<void> {
  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(() => resolve());
    else setTimeout(() => resolve(), 0);
  });
}

/** 本次发送是否用到工作区向量（仅用于界面提示，不落盘） */
type VectorRagSendHint =
  | { kind: 'skipped' }
  | { kind: 'injected'; usedChunks: number; totalChunks: number }
  | { kind: 'empty' }
  | { kind: 'error'; message: string };

/** 工作区向量索引：按用户问题检索相关片段（不落盘到聊天记录）。不设关键词门控；是否注入由主进程嵌入 + 相关度阈值决定。 */
async function maybeInjectVectorRag(
  sessionMessages: Message[],
  userMessage: Message,
  skip?: boolean
): Promise<{ messages: Message[]; ragHint: VectorRagSendHint }> {
  if (skip) {
    return { messages: [...sessionMessages, userMessage], ragHint: { kind: 'skipped' } };
  }
  const root = useWorkspaceStore.getState().rootPath.trim();
  const {
    vectorRagEnabled,
    vectorTopK,
    ragMaxInjectChars,
    getEmbedConfigForIpc,
  } = useKnowledgeStore.getState();
  const embed = getEmbedConfigForIpc();
  if (!root || !vectorRagEnabled || !embed) {
    return { messages: [...sessionMessages, userMessage], ragHint: { kind: 'skipped' } };
  }
  const q = userQueryTextForRag(userMessage);
  if (!q) {
    return { messages: [...sessionMessages, userMessage], ragHint: { kind: 'skipped' } };
  }
  try {
    const r = await window.electron.knowledgeSearch({
      root,
      query: q,
      topK: vectorTopK,
      maxChars: ragMaxInjectChars,
      embed,
    });
    if (!r.ok) {
      const msg = r.error || 'unknown';
      console.warn('[RAG]', msg);
      return {
        messages: [...sessionMessages, userMessage],
        ragHint: { kind: 'error', message: msg },
      };
    }
    const total = r.meta?.chunkCount ?? 0;
    if (!r.text?.trim()) {
      return { messages: [...sessionMessages, userMessage], ragHint: { kind: 'empty' } };
    }
    const used = r.meta?.usedChunks ?? 0;
    const inj: Message = {
      id: `vecctx-${Date.now()}`,
      role: 'system',
      content:
        '【工作区向量检索·相关素材片段】\n' +
        '以下片段由本地向量索引按语义选出，与本次用户问题最相关。请仅在不与后文其他系统说明冲突时参考；若片段不足，请向用户说明可补充的文档或重新建索引。\n\n' +
        r.text,
      timestamp: Date.now(),
      model: 'vector-rag',
    };
    return {
      messages: [inj, ...sessionMessages, userMessage],
      ragHint: { kind: 'injected', usedChunks: used, totalChunks: total },
    };
  } catch (e) {
    console.warn('[RAG] search failed', e);
    const message = e instanceof Error ? e.message : String(e);
    return {
      messages: [...sessionMessages, userMessage],
      ragHint: { kind: 'error', message },
    };
  }
}

/** 工作区根目录下 MYAGENT_KNOWLEDGE.md / knowledge.md / README.md 片段 */
async function maybeInjectWorkspaceMessages(
  sessionMessages: Message[],
  userMessage: Message,
  skip?: boolean
): Promise<Message[]> {
  if (skip) return [...sessionMessages, userMessage];
  const root = useWorkspaceStore.getState().rootPath.trim();
  if (!root) return [...sessionMessages, userMessage];
  const maxChars = useWorkspaceStore.getState().maxChars;
  try {
    const r = await window.electron.readWorkspaceHint({ root, maxChars });
    if (!r.ok || !r.text) return [...sessionMessages, userMessage];
    const inj: Message = {
      id: `wsctx-${Date.now()}`,
      role: 'system',
      content: `【工作区知识文件：${r.fileName}】\n${r.text}`,
      timestamp: Date.now(),
      model: 'workspace',
    };
    return [inj, ...sessionMessages, userMessage];
  } catch {
    return [...sessionMessages, userMessage];
  }
}

/** 发送给模型时可选注入联网摘要（不写回聊天记录）；仅关键词命中或 /web 前缀时才请求检索 */
async function buildMessagesWithOptionalWebSearch(
  sessionMessages: Message[],
  userMessage: Message,
  web: { enabled: boolean; provider: WebSearchProvider; apiKey: string }
): Promise<Message[]> {
  const outgoing: Message[] = [...sessionMessages, userMessage];
  if (!web.enabled) return outgoing;

  const raw = userMessage.content.trim();
  if (!raw || raw === '（附件）') return outgoing;

  const searchQuery = getWebSearchQueryIfTriggered(raw);
  if (!searchQuery) return outgoing;

  try {
    const res = await window.electron.webSearch({
      query: searchQuery,
      provider: web.provider,
      apiKey: web.apiKey || undefined,
    });
    let snippet = (res.text || '').trim();
    if (!snippet) {
      const hint =
        res.error || '第三方摘要接口未返回正文（DuckDuckGo 等对中文即时新闻常为空）。';
      snippet = [
        `用户已通过「搜索类」关键词请求联网参考，检索词：「${searchQuery}」。`,
        hint,
        '请仍给出可核查的要点提纲或领域框架；涉及时效须写明可能非当日头条，并建议对照央视新闻、人民网、新华网等核实。',
      ].join('\n');
    }

    const preamble =
      '【重要 · 联网模式】MyAgent 已在用户发送前执行联网检索。你必须遵守：\n' +
      '1）禁止用「无法联网」「没有实时联网能力」「不能获取最新资讯」等作为主要回答来推脱；\n' +
      '2）若下方有检索摘要，请优先概括摘要并尽量列出来源标题或链接；\n' +
      '3）若无有效摘要，请结合检索词与常识给出「要闻类型 / 关注方向」等结构化梳理，并明确标注「非实时抓取、具体事件需查权威媒体当日版面」。\n\n' +
      `【检索词】「${searchQuery}」\n\n` +
      '【检索摘要 / 说明】\n';

    const inject: Message = {
      id: `webctx-${Date.now()}`,
      role: 'system',
      content: preamble + snippet,
      timestamp: Date.now(),
      model: 'web-search',
    };
    return [inject, ...sessionMessages, userMessage];
  } catch (e) {
    console.warn('联网搜索失败', e);
    const inject: Message = {
      id: `webctx-${Date.now()}`,
      role: 'system',
      content:
        '【重要 · 联网模式】检索接口报错，但用户已发起联网类请求。禁止仅用「无法联网」推脱。\n' +
        '错误信息：' +
        (e instanceof Error ? e.message : String(e)) +
        `\n检索词：「${searchQuery}」。请说明本次检索失败，并仍基于常识给出可核查的参考方向（涉及时效请提醒用户查阅权威媒体）。`,
      timestamp: Date.now(),
      model: 'web-search',
    };
    return [inject, ...sessionMessages, userMessage];
  }
}

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

/** 已配置生图工具时注入系统说明，否则模型（如豆包）会按常识声称「不能生图」 */
function shouldUseLocalCreativePolicy(imageGenModel: ModelConfig | undefined): boolean {
  if (!imageGenModel) return false;
  return imageGenModel.provider === 'ollama' || imageGenModel.isLocal || imageGenModel.imageGeneratorConfig?.type === 'cli';
}

function prependImageGenCapabilitySystem(
  messages: Message[],
  locale: Locale,
  imageGenModel: ModelConfig | undefined
): Message[] {
  /** 只要存在任意可用的生图模型（独立于对话模型），就注入「你能生图」提示 */
  if (!modelHasUsableImageGenerator(imageGenModel)) return messages;
  const localPolicy = shouldUseLocalCreativePolicy(imageGenModel)
    ? tUi(locale, 'chat.imageGenToolLocalPolicy')
    : '';
  const inj: Message = {
    id: `imggen-sys-${Date.now()}`,
    role: 'system',
    content: tUi(locale, 'chat.imageGenToolSystemPrompt') + localPolicy,
    timestamp: Date.now(),
    model: 'myagent-capabilities',
  };
  return [inj, ...messages];
}

async function buildOutgoingChain(
  historyWithoutUser: Message[],
  userMessage: Message,
  web: { enabled: boolean; provider: WebSearchProvider; apiKey: string },
  opts?: { skipContextInject?: boolean }
): Promise<{ chain: Message[]; ragHint: VectorRagSendHint }> {
  const skip = opts?.skipContextInject === true;
  const vec = await maybeInjectVectorRag(historyWithoutUser, userMessage, skip);
  const withVec = vec.messages;
  const hist0 = withVec.slice(0, -1);
  const last0 = withVec[withVec.length - 1];
  const withWs = await maybeInjectWorkspaceMessages(hist0, last0, skip);
  const hist = withWs.slice(0, -1);
  const last = withWs[withWs.length - 1];
  const chain = await buildMessagesWithOptionalWebSearch(hist, last, web);
  return { chain, ragHint: vec.ragHint };
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

function imageReferencePathsFromFiles(files?: FileInfo[]): string[] {
  return (files ?? [])
    .filter((f) => f.type?.startsWith('image/') && f.path)
    .map((f) => f.path);
}

async function createDocumentArtifactsFromMarkdown(
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

async function postProcessAssistantContent(
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
  const generatedFiles: Array<{ path: string; url: string; width: number; height: number }> = [];
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
    const fs = await import('fs');
    const fileInfos: FileInfo[] = await Promise.all(
      generatedFiles.map(async (f, i) => {
        const fsStats = await fs.promises.stat(f.path);
        return {
          name: `generated_${imageIndexBase + i + 1}.png`,
          path: f.path,
          type: 'image/png',
          size: fsStats.size,
        };
      })
    );
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

function formatVectorRagHint(
  h: VectorRagSendHint,
  t: (key: string, params?: Record<string, string | number>) => string
): { text: string; tone: 'success' | 'info' | 'error' } | null {
  if (h.kind === 'skipped') return null;
  if (h.kind === 'injected') {
    return {
      text: t('chat.ragStatusInjected', { used: h.usedChunks, total: h.totalChunks }),
      tone: 'success',
    };
  }
  if (h.kind === 'empty') {
    return { text: t('chat.ragStatusEmpty'), tone: 'info' };
  }
  const err = h.message;
  return {
    text: t('chat.ragStatusError', {
      err: err.length > 120 ? err.slice(0, 120) + '…' : err,
    }),
    tone: 'error',
  };
}

const ChatWindow: React.FC<{ footerH?: number }> = ({ footerH = 76 }) => {
  const {
    currentSessionId,
    sessions,
    addMessage,
    removeMessage,
    removeMessages,
    updateMessage,
    appendToMessage,
    appendReasoningToMessage,
    loadingSessionId,
    loadingSessionIds,
    clearLoadingForSession,
    updateSessionTitle,
    setSessionWebOverride,
    compressingSessionIds,
  } = useChatStore();

  const webSearchEnabled = useWebSearchStore((s) => s.enabled);
  const speechInputEnabled = useSettingStore((s) => s.speechInputEnabled);
  const voiceWakeEnabled = useSettingStore((s) => s.voiceWakeEnabled);
  const voiceWakePhrase = useSettingStore((s) => s.voiceWakePhrase);
  const { t, locale: uiLocale } = useI18n();
  const systemTtsAvailable = useSystemTtsAvailable(uiLocale);
  const ttsPlaybackReady = systemTtsAvailable === true;

  const isCurrentSessionLoading =
    loadingSessionId !== null && loadingSessionIds.includes(currentSessionId ?? '');
  const isCompressingCurrent =
    !!currentSessionId && compressingSessionIds.includes(currentSessionId);
  const isSessionBusy = isCurrentSessionLoading || isCompressingCurrent;
  const { getActiveModel } = useModelStore();
  const [input, setInput] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(() => new Set());
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachmentPreviews, setAttachmentPreviews] = useState<Record<string, string>>({});
  const [isDragging, setIsDragging] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputAreaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 距底部小于该值视为「在底部」，流式输出时可自动跟随滚动 */
  const SCROLL_STICK_BOTTOM_PX = 120;
  const stickToBottomRef = useRef(true);
  const [inlineImageIndex, setInlineImageIndex] = useState(0);
  const [streamingTargetAssistantId, setStreamingTargetAssistantId] = useState<string | null>(null);
  const inlineImageIndexRef = useRef(0);
  inlineImageIndexRef.current = inlineImageIndex;
  const [isStreaming, setIsStreaming] = useState(false);
  /** 本地/HTTP 生图进行中：对话区占位，避免长耗时无反馈 */
  const [imageGenProgress, setImageGenProgress] = useState<{
    current: number;
    total: number;
    messageId: string;
  } | null>(null);
  const [vectorRagStatus, setVectorRagStatus] = useState<{
    text: string;
    tone: 'success' | 'info' | 'error';
  } | null>(null);
  const streamUnsubRef = useRef<(() => void) | null>(null);
  const streamHadErrorRef = useRef(false);
  const imageGenCancelledRef = useRef(false);
  /** 用户点击中止后 onEnd 中用于区分「无输出取消」（删气泡）与「有错结束」 */
  const streamCancelledByUserRef = useRef(false);
  const streamingAssistantIdRef = useRef<string | null>(null);
  /** 当前流式回复所属会话；切会话时点阵不误绑其他会话 */
  const streamingSessionIdRef = useRef<string | null>(null);
  /** 中文/日文等 IME 组字中为 true，避免 Enter 上屏时被当成发送 */
  const imeComposingRef = useRef(false);

  /** 与本机 UI 同步：把生图进度写入消息，便于远端壳页快照显示占位格 */
  const imageGenSyncRef = useRef<{ sessionId: string; messageId: string } | null>(null);

  /** 语音识别：与 input 同步，避免 onresult 闭包陈旧 */
  const inputSyncRef = useRef('');
  inputSyncRef.current = input;
  const handleSendRef = useRef<() => void>(() => {});
  const sendFromVoiceWakeRef = useRef(false);
  const speechReaderRef = useRef<StreamingSpeechReader | null>(null);
  const [voiceReplySpeaking, setVoiceReplySpeaking] = useState(false);
  /** 本轮回复是否来自语音唤醒闭环（唤醒听写自动发送） */
  const voiceWakeLoopRef = useRef(false);
  /** 唤醒态：唤醒词命中到发送/超时之间；驱动粒子呼吸 */
  const [voiceAwake, setVoiceAwake] = useState(false);

  const cancelVoiceReply = useCallback(() => {
    speechReaderRef.current?.cancel();
    speechReaderRef.current = null;
    setVoiceReplySpeaking(false);
  }, []);

  const consumeVoiceWakeReply = useCallback((): boolean => {
    if (!ttsPlaybackReady) return false;
    if (!useSettingStore.getState().voiceReplyEnabled) return false;
    if (!voiceWakeLoopRef.current) return false;
    voiceWakeLoopRef.current = false;
    return true;
  }, [ttsPlaybackReady]);

  const onDictationEnded = useCallback(({ autoSend, transcript }: { autoSend: boolean; transcript: string }) => {
    if (!autoSend || !transcript) return;
    voiceWakeLoopRef.current = true;
    sendFromVoiceWakeRef.current = true;
    setInput(transcript);
    window.setTimeout(() => {
      handleSendRef.current();
    }, 50);
  }, []);

  const speechLabels = useMemo(
    () => ({
      notSupported: t('chat.speechNotSupported'),
      needMic: t('chat.speechNeedMic'),
      startFailed: t('chat.speechStartFailed'),
      networkOrService: t('chat.speechNetwork'),
      noSpeech: t('chat.speechNoSpeech'),
      genericError: t('chat.speechGenericError'),
      transcribeFailed: t('chat.speechTranscribeFailed'),
      transcribeDenied: t('chat.speechMicDenied'),
    }),
    [t]
  );

  const getApiTranscribeConfig = useCallback((): SpeechApiTranscribeConfig | null => {
    const m = useModelStore.getState().getActiveModel();
    if (!m) return null;
    const key = (m.apiKey ?? '').trim();
    if (!key) return null;
    if (m.provider !== 'openai' && m.provider !== 'custom') return null;
    return { apiUrl: m.apiUrl, apiKey: key, provider: m.provider };
  }, []);

  const speechDictation = useWebSpeechDictation({
    inputValueRef: inputSyncRef,
    textareaRef: inputAreaRef,
    setInput,
    uiLocale,
    disabled: isSessionBusy || !speechInputEnabled,
    isImeComposing: () => imeComposingRef.current,
    labels: speechLabels,
    getVolcAsrConfig: () => {
      const s = useSettingStore.getState();
      if (!s.speechInputEnabled) return null;
      return {
        appKey: s.volcAsrAppKey,
        accessKey: s.volcAsrAccessKey,
        resourceId: s.volcAsrResourceId,
      };
    },
    getApiTranscribeConfig,
    onDictationEnded,
  });

  const windowFocused = useMainWindowFocused();

  const voiceWake = useVoiceWake({
    enabled: speechInputEnabled && voiceWakeEnabled,
    phrase: voiceWakePhrase,
    uiLocale,
    paused:
      isSessionBusy ||
      speechDictation.listening ||
      speechDictation.starting ||
      voiceReplySpeaking ||
      !windowFocused,
    getVolcAsrConfig: () => {
      const s = useSettingStore.getState();
      if (!s.speechInputEnabled) return null;
      return {
        appKey: s.volcAsrAppKey,
        accessKey: s.volcAsrAccessKey,
        resourceId: s.volcAsrResourceId,
      };
    },
    onWake: () => {
      setVoiceAwake(true);
      /** TTS 期间仅预拉麦克风；火山 WebSocket 在 TTS 结束后立即建连并推流 */
      const micPrep = speechDictation.prepareWakeMic();
      void (async () => {
        await Promise.all([
          micPrep,
          ttsPlaybackReady
            ? speakText(t('chat.voiceWakeAck'), uiLocale, { tailSilenceMs: 0 })
            : Promise.resolve(),
        ]);
        speechDictation.start({ fromWake: true });
      })();
    },
  });

  /** 流式开始即清掉唤醒态；同时唤醒态自动 30 秒超时 */
  useEffect(() => {
    if (isStreaming && voiceAwake) setVoiceAwake(false);
  }, [isStreaming, voiceAwake]);
  useEffect(() => {
    if (!voiceAwake) return;
    const t2 = window.setTimeout(() => setVoiceAwake(false), 30000);
    return () => window.clearTimeout(t2);
  }, [voiceAwake]);

  /**
   * 业务态 → ParticleStore.agentActivity 派生：
   * - isStreaming + 当前流消息内容为空 → thinking（思考中，旋转）
   * - isStreaming + 已有内容 → replying（回复中，呼吸）
   * - 非流式 + voiceAwake → awake（唤醒等待，呼吸）
   * - 其余 → idle
   * 手势期间由 store.gestureOverride 接管，ParticleField 会自动让 activity 派生静默。
   */
  useEffect(() => {
    const setAct = useParticleStore.getState().setAgentActivity;
    const streamOwnsCurrent =
      isStreaming &&
      streamingSessionIdRef.current != null &&
      streamingSessionIdRef.current === currentSessionId;
    if (streamOwnsCurrent) {
      const sess = sessions.find((s) => s.id === currentSessionId);
      const msg = sess?.messages.find((m) => m.id === streamingTargetAssistantId);
      const contentLen = (msg?.content ?? '').trim().length;
      setAct(contentLen > 0 ? 'replying' : 'thinking');
    } else if (voiceAwake) {
      setAct('awake');
    } else {
      setAct('idle');
    }
  }, [isStreaming, voiceAwake, sessions, currentSessionId, streamingTargetAssistantId]);

  useEffect(() => {
    const bridge = {
      open: (url: string) => agentBrowserOpen(url),
      read: (arg?: { maxChars?: number; selector?: string } | null) =>
        agentBrowserRead(arg ?? undefined),
      eval: (arg?: { js?: string } | null) => agentBrowserEval({ js: arg?.js ?? '' }),
      close: () => agentBrowserClose(),
    };
    (window as Window & { __MYAGENT_AGENT_BROWSER__?: typeof bridge }).__MYAGENT_AGENT_BROWSER__ =
      bridge;
    return () => {
      delete (window as Window & { __MYAGENT_AGENT_BROWSER__?: typeof bridge })
        .__MYAGENT_AGENT_BROWSER__;
    };
  }, []);

  useEffect(() => {
    return () => {
      useParticleStore.getState().setAgentActivity('idle');
    };
  }, []);

  useEffect(() => {
    if (!speechInputEnabled) speechDictation.abort();
  }, [speechInputEnabled, speechDictation.abort]);

  useEffect(() => {
    return () => {
      streamUnsubRef.current?.();
      streamUnsubRef.current = null;
      cancelVoiceReply();
      try {
        window.electron?.closeModelStream?.();
      } catch {
        /* ignore */
      }
    };
  }, [cancelVoiceReply]);

  useEffect(() => {
    if (systemTtsAvailable !== false) return;
    const s = useSettingStore.getState();
    if (s.voiceReplyEnabled) s.setVoiceReplyEnabled(false);
  }, [systemTtsAvailable]);

  const currentSession = sessions.find((s: ChatSession) => s.id === currentSessionId);
  const messages = currentSession?.messages || [];
  const conversationGallery = useMemo(() => buildConversationImageGallery(messages), [messages]);
  /**
   * 新对话分隔线：同一会话内，若最后两条消息间隔超过阈值，在间隔处显示一条"以下为新对话内容"。
   * 只保留最近一条断点（从后往前找第一个满足条件的）。阈值 15 分钟，参考同类软件普遍设计。
   */
  const newConversationDividerIndex = useMemo(() => {
    const GAP_MS = 15 * 60 * 1000; // 15 分钟
    if (messages.length < 2) return -1;
    for (let i = messages.length - 1; i >= 1; i--) {
      const prev = messages[i - 1];
      const curr = messages[i];
      if (
        typeof prev?.timestamp === 'number' &&
        typeof curr?.timestamp === 'number' &&
        curr.timestamp - prev.timestamp >= GAP_MS
      ) {
        return i;
      }
    }
    return -1;
  }, [messages]);
  const [conversationGalleryIdx, setConversationGalleryIdx] = useState<number | null>(null);
  const [conversationGalleryNonce, setConversationGalleryNonce] = useState(0);

  useEffect(() => {
    setConversationGalleryIdx(null);
    setConversationGalleryNonce(0);
    setVectorRagStatus(null);
    speechDictation.abort();
    cancelVoiceReply();
    voiceWakeLoopRef.current = false;
  }, [currentSessionId, speechDictation.abort, cancelVoiceReply]);

  useEffect(() => {
    if (!vectorRagStatus || vectorRagStatus.tone !== 'error') return;
    const tid = window.setTimeout(() => setVectorRagStatus(null), 6500);
    return () => window.clearTimeout(tid);
  }, [vectorRagStatus]);

  const runModelReply = useCallback(
    async (sendSessionId: string, historyBeforeUser: Message[], userMessage: Message, activeModel: ModelConfig) => {
      const session = useChatStore.getState().sessions.find((s) => s.id === sendSessionId);
      const webState = useWebSearchStore.getState();
      const webOn = effectiveWebEnabled(session, webState.enabled);
      setVectorRagStatus(null);

      const syncImgGenUi = (v: { current: number; total: number; messageId: string } | null): void => {
        if (v) {
          imageGenSyncRef.current = { sessionId: sendSessionId, messageId: v.messageId };
          setImageGenProgress(v);
          updateMessage(sendSessionId, v.messageId, {
            imageGenProgress: { current: v.current, total: v.total },
          });
          return;
        }
        setImageGenProgress(null);
        const p = imageGenSyncRef.current;
        if (p && p.sessionId === sendSessionId) {
          updateMessage(p.sessionId, p.messageId, { imageGenProgress: undefined });
          imageGenSyncRef.current = null;
        }
      };

      let chain: Message[];
      let ragHint: VectorRagSendHint;
      const exportHint = inferDocumentExportHint(userMessage.content);
      const isLocalImageFind = looksLikeLocalImageFindRequest(userMessage.content);
      const isWebBrowseTask = looksLikeWebBrowseRequest(userMessage.content);
      const willRunLocalAgent =
        isAgentToolsBuildEnabled() &&
        !exportHint?.document &&
        useSettingStore.getState().agentLocalToolsEnabled &&
        looksLikeLocalFileAgentRequest(userMessage.content);
      const willRunWebAgent =
        isAgentToolsBuildEnabled() &&
        !exportHint?.document &&
        useSettingStore.getState().agentBrowserEnabled &&
        isWebBrowseTask;
      /** 本机/网页 Agent 任务均跳过向量注入，避免无关 RAG 干扰工具链 */
      const skipContextInject = willRunLocalAgent || willRunWebAgent;
      try {
        const built = await buildOutgoingChain(
          historyBeforeUser,
          userMessage,
          {
            enabled: webOn,
            provider: webState.provider,
            apiKey: webState.apiKey,
          },
          { skipContextInject }
        );
        chain = isLocalImageFind || isWebBrowseTask
          ? built.chain
          : prependImageGenCapabilitySystem(built.chain, uiLocale, useModelStore.getState().getEffectiveImageGenModel());
        ragHint = built.ragHint;
      } catch (e) {
        console.error(e);
        addMessage(sendSessionId, {
          id: `${Date.now()}-err`,
          role: 'assistant',
          content: t('chat.buildFailed') + (e instanceof Error ? e.message : String(e)),
      timestamp: Date.now(),
      model: activeModel.name,
        });
        clearLoadingForSession(sendSessionId);
        return;
      }

      let chainForModel: Message[];
      try {
        chainForModel = await enrichMessagesForModel(chain, uiLocale);
        if (exportHint?.document) {
          chainForModel = [
            {
              id: `doc-export-sys-${Date.now()}`,
              role: 'system',
              content:
                '用户本轮明确要求可下载文档。请直接输出可作为文档保存的正文内容，使用 Markdown 标题/章节组织；不要添加“我已经为你准备好”“点击下载”“以下是文档”等聊天式前后缀，也不要把无关说明放入正文。',
              timestamp: Date.now(),
              model: 'myagent-document-export',
            },
            ...chainForModel,
          ];
        }
      } catch (e) {
        console.error(e);
        addMessage(sendSessionId, {
          id: `${Date.now()}-err2`,
          role: 'assistant',
          content: t('chat.buildFailed') + (e instanceof Error ? e.message : String(e)),
          timestamp: Date.now(),
          model: activeModel.name,
        });
        clearLoadingForSession(sendSessionId);
        return;
      }

      setVectorRagStatus(formatVectorRagHint(ragHint, t));

      const plainMessages = JSON.parse(JSON.stringify(sanitizeMessagesForModel(chainForModel))) as Message[];
      const plainModel = JSON.parse(JSON.stringify(activeModel)) as ModelConfig;
      const preplannedImageIntent = planImageIntent({
        userText: userMessage.content,
        historyBeforeUser,
        assistantText: '',
        toolCallCount: 0,
      });
      const imageToolExpected =
        preplannedImageIntent.shouldGenerate &&
        !!useModelStore.getState().getEffectiveImageGenModel();
      if (imageToolExpected) {
        plainModel.maxTokens = Math.min(plainModel.maxTokens || 1024, 1024);
      }
      const appendGeneratedImageToAssistant = (
        assistantId: string,
        image: { url: string; path: string; width: number; height: number }
      ): void => {
        const name = image.path.split(/[\\/]/).pop() || 'generated-image.png';
        const file: FileInfo = {
          name,
          path: image.path,
          type: 'image/png',
          size: 0,
          preview: image.url,
        };
        const sess = useChatStore.getState().sessions.find((s) => s.id === sendSessionId);
        const msg = sess?.messages.find((m) => m.id === assistantId);
        const prev = (msg?.files ?? []) as FileInfo[];
        if (prev.some((f) => f.path === file.path)) return;
        updateMessage(sendSessionId, assistantId, { files: [...prev, file] });
      };
      const mergeAssistantFiles = (assistantId: string, incoming?: FileInfo[]): FileInfo[] | undefined => {
        const sess = useChatStore.getState().sessions.find((s) => s.id === sendSessionId);
        const msg = sess?.messages.find((m) => m.id === assistantId);
        const merged: FileInfo[] = [...((msg?.files ?? []) as FileInfo[])];
        for (const f of incoming ?? []) {
          if (!merged.some((x) => x.path === f.path)) merged.push(f);
        }
        return merged.length ? merged : undefined;
      };

      if (
        isAgentToolsBuildEnabled() &&
        !exportHint?.document &&
        (useSettingStore.getState().agentLocalToolsEnabled ||
          (useSettingStore.getState().agentBrowserEnabled &&
            looksLikeWebBrowseRequest(userMessage.content)))
      ) {
        const assistantId = `${Date.now() + 1}-a`;
        streamingAssistantIdRef.current = assistantId;
        streamingSessionIdRef.current = sendSessionId;
        setStreamingTargetAssistantId(assistantId);
        setIsStreaming(true);
        addMessage(sendSessionId, {
          id: assistantId,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          model: activeModel.name,
        });

        let pendingReasoningDelta = '';
        let reasoningFlushRaf = 0;
        const drainAgentReasoning = (): void => {
          if (reasoningFlushRaf !== 0) {
            window.cancelAnimationFrame(reasoningFlushRaf);
            reasoningFlushRaf = 0;
          }
          const merged = pendingReasoningDelta;
          pendingReasoningDelta = '';
          if (!merged) return;
          appendReasoningToMessage(sendSessionId, assistantId, merged);
        };
        const queueAgentReasoning = (th: string): void => {
          if (!th) return;
          pendingReasoningDelta += th;
          if (reasoningFlushRaf !== 0) return;
          reasoningFlushRaf = window.requestAnimationFrame(() => {
            reasoningFlushRaf = 0;
            drainAgentReasoning();
          });
        };

        try {
          streamCancelledByUserRef.current = false;
          const agentOut = await runAgentLoop({
            chatSessionId: sendSessionId,
            chainMessages: chainForModel,
            model: activeModel,
            userText: userMessage.content,
            locale: uiLocale,
            onThinkingDelta: queueAgentReasoning,
            shouldCancel: () => streamCancelledByUserRef.current,
            onReplyContent: (text) => {
              updateMessage(sendSessionId, assistantId, { content: text });
            },
          });
          drainAgentReasoning();
          if (agentOut.handled && agentOut.displayText !== undefined) {
            if (agentOut.reasoning) {
              const sess = useChatStore.getState().sessions.find((s) => s.id === sendSessionId);
              const msg = sess?.messages.find((m) => m.id === assistantId);
              const priorReason = (msg?.reasoning ?? '').trim();
              if (!priorReason && agentOut.reasoning.trim()) {
                appendReasoningToMessage(sendSessionId, assistantId, agentOut.reasoning);
              }
            }
            if (consumeVoiceWakeReply()) {
              speechReaderRef.current?.cancel();
              const reader = new StreamingSpeechReader(uiLocale, {
                onSpeakingChange: setVoiceReplySpeaking,
              });
              speechReaderRef.current = reader;
              void (async () => {
                await reader.start();
                const speakBody = stripGenerateImageArtifactsForDisplay(agentOut.displayText!).trim();
                if (speakBody) {
                  reader.push(speakBody);
                  reader.finish();
                }
              })();
            }
            const imageHooks: ImageGenProgressHooks = {
              onBegin: ({ total }) => {
                imageGenCancelledRef.current = false;
                syncImgGenUi({ current: 1, total, messageId: assistantId });
              },
              onEachStart: ({ current, total }) => syncImgGenUi({ current, total, messageId: assistantId }),
              onEachDone: ({ done, total }) =>
                syncImgGenUi(
                  done >= total
                    ? { current: total, total, messageId: assistantId }
                    : { current: done + 1, total, messageId: assistantId }
                ),
              onImage: ({ image }) => appendGeneratedImageToAssistant(assistantId, image),
              onDone: () => syncImgGenUi(null),
            };
            const plannedIntent = planImageIntent({
              userText: userMessage.content,
              historyBeforeUser,
              assistantText: agentOut.displayText,
              toolCallCount: extractGenerateImageCalls(agentOut.displayText).length,
            });
            if (isLocalImageFind || isWebBrowseTask) {
              updateMessage(sendSessionId, assistantId, {
                content: agentOut.displayText ?? '',
                files: mergeAssistantFiles(assistantId, agentOut.exportFiles),
                imageGenProgress: undefined,
              });
            } else {
            const { content: c, files } = await postProcessAssistantContent(
              agentOut.displayText,
              activeModel,
              inlineImageIndexRef.current,
              setInlineImageIndex,
              {
                imageGenHooks: imageHooks,
                referenceImages: imageReferencePathsFromFiles(userMessage.files),
                userPromptContext: userMessage.content,
                plannedIntent,
                shouldCancel: () => imageGenCancelledRef.current,
              }
            );
            updateMessage(sendSessionId, assistantId, {
              content: c,
              files: mergeAssistantFiles(assistantId, [
                ...(files ?? []),
                ...(agentOut.exportFiles ?? []),
              ]),
              imageGenProgress: undefined,
            });
            }
            setIsStreaming(false);
            streamingAssistantIdRef.current = null;
            streamingSessionIdRef.current = null;
            setStreamingTargetAssistantId(null);
            clearLoadingForSession(sendSessionId);
            return;
          }
        } catch (agentErr) {
          console.error('[Agent]', agentErr);
          drainAgentReasoning();
          const cancelled =
            streamCancelledByUserRef.current ||
            (agentErr instanceof Error &&
              (agentErr.message === 'AGENT_CANCELLED' ||
                (agentErr as Error & { code?: string }).code === 'AGENT_CANCELLED'));
          updateMessage(sendSessionId, assistantId, {
            content: cancelled
              ? t('chat.stoppedBanner')
              : t('chat.requestFailed') + (agentErr instanceof Error ? agentErr.message : String(agentErr)),
          });
          clearLoadingForSession(sendSessionId);
          return;
        } finally {
          setIsStreaming(false);
          streamingAssistantIdRef.current = null;
          streamingSessionIdRef.current = null;
          setStreamingTargetAssistantId(null);
          streamCancelledByUserRef.current = false;
        }
      }

      if (exportHint?.document && canUseSseStream(activeModel)) {
        streamHadErrorRef.current = false;
        streamCancelledByUserRef.current = false;
        const assistantId = `${Date.now()}-doc`;
        let artifactBuffer = '';
        streamingAssistantIdRef.current = assistantId;
        streamingSessionIdRef.current = sendSessionId;
        setStreamingTargetAssistantId(assistantId);
        setIsStreaming(true);
        addMessage(sendSessionId, {
          id: assistantId,
          role: 'assistant',
          content: '',
          exportHint: { ...exportHint, status: 'thinking' },
          timestamp: Date.now(),
          model: activeModel.name,
        });

        let docPendingReasoning = '';
        let docReasoningFlushRaf = 0;
        const flushDocReasoningImmediately = (): void => {
          if (docReasoningFlushRaf !== 0) {
            window.cancelAnimationFrame(docReasoningFlushRaf);
            docReasoningFlushRaf = 0;
          }
          const merged = docPendingReasoning;
          docPendingReasoning = '';
          if (!merged) return;
          appendReasoningToMessage(sendSessionId, assistantId, merged);
        };
        const queueDocReasoningChunk = (th: string): void => {
          docPendingReasoning += th;
          if (docReasoningFlushRaf !== 0) return;
          docReasoningFlushRaf = window.requestAnimationFrame(() => {
            docReasoningFlushRaf = 0;
            flushDocReasoningImmediately();
          });
        };

        const unsub = window.electron.subscribeModelStream(plainMessages, plainModel, {
          onDelta: (d) => {
            artifactBuffer += d;
          },
          onThinkingDelta: (th) => {
            if (th) queueDocReasoningChunk(th);
          },
          onError: (m) => {
            flushDocReasoningImmediately();
            streamHadErrorRef.current = true;
            updateMessage(sendSessionId, assistantId, {
              content: t('chat.requestFailed') + m,
              exportHint,
            });
          },
          locale: uiLocale,
          onEnd: () => {
            void (async () => {
              flushDocReasoningImmediately();
              streamUnsubRef.current = null;
              const aborted = streamCancelledByUserRef.current;
              streamCancelledByUserRef.current = false;
              try {
                if (streamHadErrorRef.current) return;
                if (aborted) {
                  updateMessage(sendSessionId, assistantId, {
                    content: t('chat.stoppedBanner'),
                    exportHint,
                  });
                  return;
                }
                const artifactBody = stripGenerateImageArtifactsForDisplay(artifactBuffer).trim();
                updateMessage(sendSessionId, assistantId, {
                  exportHint: { ...exportHint, status: 'generating' },
                });
                const artifactFiles = await createDocumentArtifactsFromMarkdown(
                  artifactBody,
                  documentExportFormatsFromHint(exportHint),
                  documentArtifactBaseNameFromContent(
                    artifactBody,
                    documentArtifactBaseName(userMessage.content)
                  )
                );
                updateMessage(sendSessionId, assistantId, {
                  content: artifactFiles.length
                    ? '文档已生成，点击下方文件即可查看或另存。'
                    : '文档内容已生成，但写入本地文件失败。请重试或检查文档目录权限。',
                  exportHint,
                  files: artifactFiles.length ? artifactFiles : undefined,
                });
              } finally {
                setIsStreaming(false);
                clearLoadingForSession(sendSessionId);
                streamingAssistantIdRef.current = null;
                streamingSessionIdRef.current = null;
                setStreamingTargetAssistantId(null);
              }
            })();
          },
        });
        streamUnsubRef.current = unsub;
        return;
      }

      const useStream =
        !exportHint?.document &&
        useSettingStore.getState().streamResponses &&
        canUseSseStream(activeModel);

      if (useStream) {
        streamHadErrorRef.current = false;
        streamCancelledByUserRef.current = false;
        const assistantId = `${Date.now()}-a`;
        streamingAssistantIdRef.current = assistantId;
        streamingSessionIdRef.current = sendSessionId;
        setStreamingTargetAssistantId(assistantId);
        setIsStreaming(true);
        addMessage(sendSessionId, {
          id: assistantId,
        role: 'assistant',
          content: '',
          ...(exportHint ? { exportHint } : {}),
        timestamp: Date.now(),
        model: activeModel.name,
        });

        if (consumeVoiceWakeReply()) {
          speechReaderRef.current?.cancel();
          const reader = new StreamingSpeechReader(uiLocale, {
            onSpeakingChange: setVoiceReplySpeaking,
          });
          speechReaderRef.current = reader;
          void reader.start();
        }

        const voiceReplyThisTurn = Boolean(speechReaderRef.current);

        const imgBase = inlineImageIndexRef.current;
        /**
         * 逐字符动画流式渲染器（content 和 reasoning 共用）。
         *
         * 用固定间隔定时器（TICK_MS=25ms ≈ 40fps 写入）替代 rAF，
         * 每次tick取少量字符追加到 store。固定间隔保证帧间衔接均匀无"瘸"感。
         *
         * 速度档位（在上一版基础上再降 ~10%）：
         * - buffer ≤14 字 → 每次 1 字（最丝滑）
         * - ≤38 字 → 每次 2 字
         * - ≤90 字 → 每次 len/12
         * - >90 字 → 每次 len/6（积压严重时加速追赶）
         */
        const TICK_MS = 25;
        const createAnimStream = (
          appendFn: (sessionId: string, msgId: string, chunk: string) => void
        ) => {
          let buffer = '';
          let timerId: ReturnType<typeof setInterval> | null = null;
          const flush = () => {
            if (timerId !== null) {
              clearInterval(timerId);
              timerId = null;
            }
            if (!buffer) return;
            appendFn(sendSessionId, assistantId, buffer);
            buffer = '';
          };
          const tick = () => {
            if (!buffer) {
              if (timerId !== null) {
                clearInterval(timerId);
                timerId = null;
              }
              return;
            }
            const len = buffer.length;
            let take: number;
            if (len <= 14) take = 1;
            else if (len <= 38) take = 2;
            else if (len <= 90) take = Math.ceil(len / 12);
            else take = Math.ceil(len / 6);
            const chunk = buffer.slice(0, take);
            buffer = buffer.slice(take);
            appendFn(sendSessionId, assistantId, chunk);
          };
          return {
            push(d: string) {
              if (!d) return;
              buffer += d;
              if (timerId === null) {
                timerId = setInterval(tick, TICK_MS);
              }
            },
            flush,
          };
        };

        const contentStream = createAnimStream(appendToMessage);
        const reasoningStream = createAnimStream(appendReasoningToMessage);
        const flushPendingContentDeltaImmediately = contentStream.flush;
        const drainReasoningBufferUnsafe = reasoningStream.flush;
        const queueContentDeltaChunk = contentStream.push;
        const queueReasoningDeltaChunk = reasoningStream.push;

        const unsub = window.electron.subscribeModelStream(plainMessages, plainModel, {
          onDelta: (d) => {
            queueContentDeltaChunk(d);
            if (voiceReplyThisTurn) {
              speechReaderRef.current?.push(d);
            }
          },
          onThinkingDelta: (th) => {
            if (th) queueReasoningDeltaChunk(th);
          },
          onError: (m) => {
            flushPendingContentDeltaImmediately();
            drainReasoningBufferUnsafe();
            speechReaderRef.current?.cancel();
            setVoiceReplySpeaking(false);
            streamHadErrorRef.current = true;
            const sess = useChatStore.getState().sessions.find((s) => s.id === sendSessionId);
            const prior = sess?.messages.find((x) => x.id === assistantId)?.content?.trimEnd() ?? '';
            const injected = prior
              ? `${prior}\n\n---\n\n${t('chat.streamInterrupted')}\n${m}`
              : `${t('chat.streamInterrupted')}\n${m}`;
            updateMessage(sendSessionId, assistantId, { content: injected });
          },
          locale: uiLocale,
          onEnd: () => {
            void (async () => {
              flushPendingContentDeltaImmediately();
              drainReasoningBufferUnsafe();
              streamUnsubRef.current = null;
              const aborted = streamCancelledByUserRef.current;
              streamCancelledByUserRef.current = false;

              try {
                if (streamHadErrorRef.current) {
                  speechReaderRef.current?.cancel();
                  setVoiceReplySpeaking(false);
                  setIsStreaming(false);
                  clearLoadingForSession(sendSessionId);
                  streamingAssistantIdRef.current = null;
                  streamingSessionIdRef.current = null;
                  setStreamingTargetAssistantId(null);
                  return;
                }

                const msg = useChatStore.getState()
                  .sessions.find((s) => s.id === sendSessionId)
                  ?.messages.find((m) => m.id === assistantId);
                const raw = msg?.content ?? '';
                const reasoningText = (msg?.reasoning ?? '').trim();

                const plannedIntent = planImageIntent({
                  userText: userMessage.content,
                  historyBeforeUser,
                  assistantText: raw,
                  toolCallCount: extractGenerateImageCalls(raw).length,
                });

                if (aborted && !raw.trim() && !plannedIntent.shouldGenerate) {
                  speechReaderRef.current?.cancel();
                  setVoiceReplySpeaking(false);
                  removeMessage(sendSessionId, assistantId);
                  setIsStreaming(false);
                  clearLoadingForSession(sendSessionId);
                  streamingAssistantIdRef.current = null;
                  streamingSessionIdRef.current = null;
                  setStreamingTargetAssistantId(null);
                  return;
                }

                /** SSE 正文已全部写入本地消息；先于生图后处理解除「流式」态，使 strip 与生图占位顺序符合「先说清再画图」 */
                setIsStreaming(false);
                streamingAssistantIdRef.current = null;
                streamingSessionIdRef.current = null;
                setStreamingTargetAssistantId(null);
                speechReaderRef.current?.finish();

                let nextContent = raw;
                let nextFiles = msg?.files as Message['files'] | undefined;
                if (raw.trim() || plannedIntent.shouldGenerate) {
                  try {
                    const imageHooks: ImageGenProgressHooks = {
                      onBegin: ({ total }) => {
                        imageGenCancelledRef.current = false;
                        syncImgGenUi({ current: 1, total, messageId: assistantId });
                      },
                      onEachStart: ({ current, total }) =>
                        syncImgGenUi({ current, total, messageId: assistantId }),
                      onEachDone: ({ done, total }) =>
                        syncImgGenUi(
                          done >= total
                            ? { current: total, total, messageId: assistantId }
                            : { current: done + 1, total, messageId: assistantId }
                        ),
                      onImage: ({ image }) => appendGeneratedImageToAssistant(assistantId, image),
                      onDone: () => syncImgGenUi(null),
                    };
                    const { content, files } = await postProcessAssistantContent(
                      raw,
                      activeModel,
                      imgBase,
                      setInlineImageIndex,
                      {
                        imageGenHooks: imageHooks,
                        referenceImages: imageReferencePathsFromFiles(userMessage.files),
                        userPromptContext: userMessage.content,
                        plannedIntent,
                        shouldCancel: () => imageGenCancelledRef.current,
                      }
                    );
                    nextContent = content;
                    nextFiles = mergeAssistantFiles(assistantId, files);
                  } catch (e) {
                    nextContent =
                      raw + '\n\n' + t('postProcess.tag') + (e instanceof Error ? e.message : String(e));
                  }
                  if (aborted) {
                    nextContent =
                      `${nextContent}\n\n---\n\n${t('chat.stoppedBanner')}`;
                  }
                }
                if (!nextContent.trim() && !nextFiles?.length && reasoningText) {
                  nextContent = t('chat.emptyAfterReasoning');
                }

                updateMessage(sendSessionId, assistantId, {
                  content: nextContent,
                  files: mergeAssistantFiles(assistantId, nextFiles as FileInfo[] | undefined),
                  ...(exportHint ? { exportHint } : {}),
                  imageGenProgress: undefined,
                });
              } finally {
                setIsStreaming(false);
                clearLoadingForSession(sendSessionId);
                streamingAssistantIdRef.current = null;
                streamingSessionIdRef.current = null;
                setStreamingTargetAssistantId(null);
              }
            })();
          },
        });
        streamUnsubRef.current = unsub;
        return;
      }

      const documentArtifactAssistantId = exportHint?.document ? `${Date.now()}-doc` : '';
      try {
        if (documentArtifactAssistantId) {
          addMessage(sendSessionId, {
            id: documentArtifactAssistantId,
            role: 'assistant',
            content: '',
            exportHint: { ...exportHint!, status: 'generating' },
            timestamp: Date.now(),
            model: activeModel.name,
          });
        }
        const response = await window.electron.callModel(plainMessages, plainModel, { locale: uiLocale });
        const content0 = response.content || t('chat.fallbackReply');
        const reasoningIn =
          typeof (response as { reasoning?: unknown }).reasoning === 'string'
            ? String((response as { reasoning?: string }).reasoning).trim()
            : '';
        if (exportHint?.document) {
          const artifactBody = stripGenerateImageArtifactsForDisplay(content0).trim();
          const artifactFiles = await createDocumentArtifactsFromMarkdown(
            artifactBody,
            documentExportFormatsFromHint(exportHint),
            documentArtifactBaseNameFromContent(
              artifactBody,
              documentArtifactBaseName(userMessage.content)
            )
          );
          updateMessage(sendSessionId, documentArtifactAssistantId, {
            content: artifactFiles.length
              ? '文档已生成，点击下方文件即可查看或另存。'
              : '文档内容已生成，但写入本地文件失败。请重试或检查文档目录权限。',
            ...(reasoningIn ? { reasoning: reasoningIn } : {}),
            exportHint,
            files: artifactFiles.length ? artifactFiles : undefined,
          });
          return;
        }
        const assistantId = `${Date.now() + 1}-a`;
        addMessage(sendSessionId, {
          id: assistantId,
          role: 'assistant',
          content: content0,
          ...(reasoningIn ? { reasoning: reasoningIn } : {}),
          ...(exportHint ? { exportHint } : {}),
          timestamp: Date.now(),
          model: activeModel.name,
        });
        if (consumeVoiceWakeReply()) {
          speechReaderRef.current?.cancel();
          const reader = new StreamingSpeechReader(uiLocale, {
            onSpeakingChange: setVoiceReplySpeaking,
          });
          speechReaderRef.current = reader;
          void (async () => {
            await reader.start();
            const speakBody = stripGenerateImageArtifactsForDisplay(content0).trim();
            if (speakBody) {
              reader.push(speakBody);
              reader.finish();
            }
          })();
        }
        const imageHooks: ImageGenProgressHooks = {
          onBegin: ({ total }) => {
            imageGenCancelledRef.current = false;
            syncImgGenUi({ current: 1, total, messageId: assistantId });
          },
          onEachStart: ({ current, total }) => syncImgGenUi({ current, total, messageId: assistantId }),
          onEachDone: ({ done, total }) =>
            syncImgGenUi(
              done >= total
                ? { current: total, total, messageId: assistantId }
                : { current: done + 1, total, messageId: assistantId }
            ),
          onImage: ({ image }) => appendGeneratedImageToAssistant(assistantId, image),
          onDone: () => syncImgGenUi(null),
        };
        const plannedIntent = planImageIntent({
          userText: userMessage.content,
          historyBeforeUser,
          assistantText: content0,
          toolCallCount: extractGenerateImageCalls(content0).length,
        });
        const { content: c, files } = await postProcessAssistantContent(
          content0,
          activeModel,
          inlineImageIndexRef.current,
          setInlineImageIndex,
          {
            imageGenHooks: imageHooks,
            referenceImages: imageReferencePathsFromFiles(userMessage.files),
            userPromptContext: userMessage.content,
            plannedIntent,
            shouldCancel: () => imageGenCancelledRef.current,
          }
        );
        updateMessage(sendSessionId, assistantId, {
          content: c,
          ...(reasoningIn ? { reasoning: reasoningIn } : {}),
          ...(exportHint ? { exportHint } : {}),
          files: mergeAssistantFiles(assistantId, files),
          imageGenProgress: undefined,
        });
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (documentArtifactAssistantId) {
          updateMessage(sendSessionId, documentArtifactAssistantId, {
            content: t('chat.requestFailed') + msg,
          });
          return;
        }
        addMessage(sendSessionId, {
          id: `${Date.now()}-a`,
          role: 'assistant',
          content: t('chat.requestFailed') + msg,
          timestamp: Date.now(),
          model: activeModel.name,
        });
    } finally {
      clearLoadingForSession(sendSessionId);
    }
    },
    [
      addMessage,
      appendReasoningToMessage,
      appendToMessage,
      clearLoadingForSession,
      removeMessage,
      updateMessage,
      t,
      uiLocale,
      consumeVoiceWakeReply,
    ]
  );

  const runModelReplyRef = useRef(runModelReply);
  runModelReplyRef.current = runModelReply;

  const handleStop = () => {
    streamCancelledByUserRef.current = true;
    imageGenCancelledRef.current = true;
    setImageGenProgress(null);
    const p = imageGenSyncRef.current;
    if (p) {
      updateMessage(p.sessionId, p.messageId, { imageGenProgress: undefined });
      imageGenSyncRef.current = null;
    }
    window.electron.closeModelStream();
    streamUnsubRef.current?.();
    streamUnsubRef.current = null;
    setIsStreaming(false);
    streamingSessionIdRef.current = null;
    const sid = currentSessionId;
    if (sid) clearLoadingForSession(sid);
    /** streamingAssistantIdRef 由 onEnd 清理，便于识别待删空气泡 */
  };

  const handleEditMessage = (message: Message) => {
    if (isSessionBusy) return;
    setEditingMessageId(message.id);
  };

  const cancelEdit = () => {
    setEditingMessageId(null);
  };

  const startSelection = (messageId?: string) => {
    setSelectionMode(true);
    setSelectedMessageIds(messageId ? new Set([messageId]) : new Set());
  };

  const toggleMessageSelection = (messageId: string) => {
    setSelectedMessageIds((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  };

  const cancelSelection = () => {
    setSelectionMode(false);
    setSelectedMessageIds(new Set());
  };

  const deleteSelectedMessages = () => {
    if (!currentSessionId || selectedMessageIds.size === 0) return;
    if (!window.confirm(t('chat.confirmDeleteMessages', { count: selectedMessageIds.size }))) return;
    if (editingMessageId && selectedMessageIds.has(editingMessageId)) setEditingMessageId(null);
    removeMessages(currentSessionId, [...selectedMessageIds]);
    cancelSelection();
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files) {
      const files = Array.from(e.dataTransfer.files);
      setAttachments((prev) => [...prev, ...files]);
      for (const f of files) {
        if (f.type.startsWith('image/')) {
          const url = URL.createObjectURL(f);
          setAttachmentPreviews((p) => ({ ...p, [f.name]: url }));
        }
      }
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const files = Array.from(e.target.files as FileList);
      setAttachments((prev) => [...prev, ...files]);
      for (const f of files) {
        if (f.type.startsWith('image/')) {
          const url = URL.createObjectURL(f);
          setAttachmentPreviews((p) => ({ ...p, [f.name]: url }));
        }
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeAttachment = (index: number) => {
    const removed = attachments[index];
    setAttachments((prev) => prev.filter((_, i) => i !== index));
    if (removed && removed.name in attachmentPreviews) {
      URL.revokeObjectURL(attachmentPreviews[removed.name]);
      setAttachmentPreviews((p) => {
        const np = { ...p };
        delete np[removed.name];
        return np;
      });
    }
  };

  useEffect(() => {
    stickToBottomRef.current = true;
  }, [currentSessionId]);

  /** 出现生图占位时贴底，减少「卡住」体感 */
  useLayoutEffect(() => {
    if (!imageGenProgress || !stickToBottomRef.current) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [imageGenProgress]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const syncStickToBottom = () => {
      stickToBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_STICK_BOTTOM_PX;
    };
    el.addEventListener('scroll', syncStickToBottom, { passive: true });
    syncStickToBottom();
    return () => el.removeEventListener('scroll', syncStickToBottom);
  }, [currentSessionId]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (!stickToBottomRef.current) return;
      el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [currentSessionId]);

  useEffect(() => {
    return () => {
      Object.values(attachmentPreviews).forEach((url) => URL.revokeObjectURL(url));
    };
  }, [attachmentPreviews]);

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electron : undefined;
    if (!api?.onMessage) return;
    const off = api.onMessage('myagent-clipboard-paste', (clip: string) => {
      const c = String(clip ?? '');
      if (!c) return;
      setInput((prev) => (prev ? `${prev}\n${c}` : c));
    });
    return off;
  }, []);

  useEffect(() => {
    type RemoteBridgePayload = { sessionId: string; content: string; attachments?: FileInfo[] };
    const snapshotMessage = (m: Message) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      reasoning: m.reasoning,
      files: m.files,
      timestamp: m.timestamp,
      model: m.model,
      exportHint: m.exportHint,
      imageGenProgress: m.imageGenProgress,
    });
    const bridge = {
      getSnapshot: async () => {
        const chat = useChatStore.getState();
        const {
          sessions: ss,
          currentSessionId: cid,
          loadingSessionId,
          loadingSessionIds,
          compressingSessionIds,
          compressingSessionId,
        } = chat;
        return {
          sessions: ss.map((s) => ({
            id: s.id,
            title: s.title,
            updatedAt: s.updatedAt,
            createdAt: s.createdAt,
            unread: Boolean(s.unreadAssistantReply),
            messages: s.messages.map(snapshotMessage),
          })),
          currentSessionId: cid,
          loadingSessionId,
          loadingSessionIds,
          compressingSessionId,
          compressingSessionIds,
        };
      },
      getActiveModelLabel: async () => {
        await useModelStore.persist?.rehydrate?.();
        useModelStore.getState().initializeDefaultModels();
        return useModelStore.getState().getActiveModel()?.name ?? '';
      },
      getModelsSnapshot: async () => {
        await useModelStore.persist?.rehydrate?.();
        const ms = useModelStore.getState();
        ms.initializeDefaultModels();
        return {
          models: ms.models.map((m) => ({ id: m.id, name: m.name })),
          activeModelId: ms.activeModelId,
        };
      },
      setActiveModelId: async (modelId: string) => {
        await useModelStore.persist?.rehydrate?.();
        useModelStore.getState().initializeDefaultModels();
        const id = String(modelId ?? '').trim();
        const locale = useSettingStore.getState().locale;
        if (!id) throw new Error(tUi(locale, 'remoteGateway.modelIdRequired'));
        const ms = useModelStore.getState();
        if (!ms.models.some((m) => m.id === id)) {
          throw new Error(tUi(locale, 'remoteGateway.modelNotFound'));
        }
        ms.setActiveModel(id);
        await flushZustandFilePersist();
      },
      collectChatImageAttachmentPathsForMediaLibrary: async () => {
        const paths = new Set<string>();
        for (const s of useChatStore.getState().sessions) {
          for (const m of s.messages ?? []) {
            for (const f of m.files ?? []) {
              if (!f?.type?.startsWith('image/')) continue;
              const p = String(f.path ?? '').trim();
              if (p) paths.add(p);
            }
          }
        }
        return [...paths];
      },
      createChatSession: async () => {
        const sessionId = useChatStore.getState().createSession();
        return { sessionId };
      },
      switchToSession: async (sessionId: string) => {
        useChatStore.getState().switchSession(sessionId);
      },
      removeChatMessagesRemote: async (payload: { sessionId: string; messageIds: string[] }) => {
        const sessionId = String(payload.sessionId ?? '').trim();
        const ids = Array.isArray(payload.messageIds)
          ? [...new Set(payload.messageIds.map((x) => String(x ?? '').trim()).filter(Boolean))]
          : [];
        const chat = useChatStore.getState();
        if (!sessionId) throw new Error('remote: session missing');
        if (!ids.length) throw new Error('remote: empty message ids');
        if (!chat.sessions.some((s) => s.id === sessionId)) {
          throw new Error('remote: session not found');
        }
        chat.removeMessages(sessionId, ids);
        await flushZustandFilePersist();
      },
      patchChatMessageRemote: async (payload: { sessionId: string; messageId: string; content: string }) => {
        const sessionId = String(payload.sessionId ?? '').trim();
        const messageId = String(payload.messageId ?? '').trim();
        const content = typeof payload.content === 'string' ? payload.content : '';
        const chat = useChatStore.getState();
        if (!sessionId || !messageId) throw new Error('remote: missing ids');
        const sess = chat.sessions.find((s) => s.id === sessionId);
        if (!sess) throw new Error('remote: session not found');
        if (!sess.messages.some((m) => m.id === messageId)) throw new Error('remote: message not found');
        chat.updateMessage(sessionId, messageId, { content });
        await flushZustandFilePersist();
      },
      resubmitEditedUserMessageRemote: async (payload: {
        sessionId: string;
        messageId: string;
        content: string;
      }) => {
        await useModelStore.persist?.rehydrate?.();
        useModelStore.getState().initializeDefaultModels();

        const sessionId = String(payload.sessionId ?? '').trim();
        const messageId = String(payload.messageId ?? '').trim();
        const textContent = String(payload.content ?? '').trim();
        const locale = useSettingStore.getState().locale;

        const activeModel = useModelStore.getState().getActiveModel();
        if (!activeModel) throw new Error(tUi(locale, 'chat.configureModel'));

        const chat = useChatStore.getState();
        const sess = chat.sessions.find((s) => s.id === sessionId);
        if (!sess) throw new Error(tUi(locale, 'remoteGateway.sessionMissing'));

        chat.switchSession(sessionId);

        const msgs = sess.messages;
        const sourceIndex = msgs.findIndex((m) => m.id === messageId);
        if (sourceIndex < 0) throw new Error('remote: message not found');
        const sourceMessage = msgs[sourceIndex];
        if (sourceMessage.role !== 'user') throw new Error('remote: only user messages can be resent');

        if (!textContent) throw new Error(tUi(locale, 'remoteGateway.emptySend'));

        if (!tryClaimSessionSend(sessionId)) {
          throw new Error(tUi(locale, 'remoteGateway.busySession'));
        }

        let priorMessages = msgs.slice(0, sourceIndex);
        const userMessage: Message = {
          ...sourceMessage,
          role: 'user',
          content: textContent,
          timestamp: Date.now(),
          model: activeModel.name,
        };
        const staleMessageIds = msgs.slice(sourceIndex + 1).map((m) => m.id);

        try {
          const webOn = effectiveWebEnabled(sess, useWebSearchStore.getState().enabled);
          const ensured = await ensureContextBeforeSend({
            sessionId,
            priorMessages,
            draftInput: textContent,
            model: activeModel,
            locale: locale === 'en' ? 'en' : 'zh',
            summaryTitle: tUi(locale, 'chat.contextSummaryTitle'),
            editSourceMessageId: messageId,
            injectExtras: resolveInjectExtras({ webEnabled: webOn }),
          });
          priorMessages = ensured.priorMessages;

          chat.updateMessage(sessionId, messageId, {
            content: textContent,
            timestamp: userMessage.timestamp,
            model: activeModel.name,
          });
          if (staleMessageIds.length > 0) chat.removeMessages(sessionId, staleMessageIds);

          if (
            !addFullTextBypassIfNeeded({
              sessionId,
              modelName: activeModel.name,
              textContent,
              hasAttachments: Boolean(sourceMessage.files?.length),
            })
          ) {
            await runModelReplyRef.current(sessionId, priorMessages, userMessage, activeModel);
          }
          await flushZustandFilePersist();
        } catch (e) {
          chat.clearLoadingForSession(sessionId);
          throw e;
        }
      },
      sendChat: async (payload: RemoteBridgePayload) => {
        await useModelStore.persist?.rehydrate?.();
        useModelStore.getState().initializeDefaultModels();
        const { sessionId, content, attachments: attIn } = payload;
        const attachments = Array.isArray(attIn)
          ? attIn.filter(
              (a): a is FileInfo =>
                Boolean(a && typeof (a as FileInfo).path === 'string' && (a as FileInfo).path.length > 0)
            )
          : [];
        const locale = useSettingStore.getState().locale;
        const activeModel = useModelStore.getState().getActiveModel();
        if (!activeModel) {
          throw new Error(tUi(locale, 'chat.configureModel'));
        }
        const chat = useChatStore.getState();
        const sess = chat.sessions.find((s) => s.id === sessionId);
        if (!sess) {
          throw new Error(tUi(locale, 'remoteGateway.sessionMissing'));
        }
        chat.switchSession(sessionId);
        let priorMessages = sess.messages.slice();
        const att = tUi(locale, 'chat.attachment');
        const textContent = content.trim() || (attachments.length > 0 ? att : '');
        if (!textContent.trim() && attachments.length === 0) {
          throw new Error(tUi(locale, 'remoteGateway.emptySend'));
        }

        if (!tryClaimSessionSend(sessionId)) {
          throw new Error(tUi(locale, 'remoteGateway.busySession'));
        }

        try {
          const webOn = effectiveWebEnabled(sess, useWebSearchStore.getState().enabled);
          const ensured = await ensureContextBeforeSend({
            sessionId,
            priorMessages,
            draftInput: textContent,
            model: activeModel,
            locale: locale === 'en' ? 'en' : 'zh',
            summaryTitle: tUi(locale, 'chat.contextSummaryTitle'),
            injectExtras: resolveInjectExtras({ webEnabled: webOn }),
          });
          priorMessages = ensured.priorMessages;

          if (priorMessages.length === 0) {
            const titleCandidate =
              (textContent === att ? tUi(locale, 'chat.attachmentTitle') : textContent) ||
              tUi(locale, 'session.newTitle');
            chat.updateSessionTitle(
              sessionId,
              titleCandidate.length > 15 ? titleCandidate.substring(0, 15) + '...' : titleCandidate
            );
          }
          const userMessage: Message = {
            id: Date.now().toString(),
            role: 'user',
            content: textContent,
            files: attachments.length > 0 ? attachments : undefined,
            timestamp: Date.now(),
            model: activeModel.name,
          };
          chat.addMessage(sessionId, userMessage);

          if (
            !addFullTextBypassIfNeeded({
              sessionId,
              modelName: activeModel.name,
              textContent,
              hasAttachments: attachments.length > 0,
            })
          ) {
            await runModelReplyRef.current(sessionId, priorMessages, userMessage, activeModel);
          }
          await flushZustandFilePersist();
        } catch (e) {
          chat.clearLoadingForSession(sessionId);
          throw e;
        }
      },
    };
    (window as unknown as { __MYAGENT_REMOTE_BRIDGE__?: typeof bridge }).__MYAGENT_REMOTE_BRIDGE__ = bridge;
    return () => {
      const w = window as unknown as { __MYAGENT_REMOTE_BRIDGE__?: typeof bridge };
      if (w.__MYAGENT_REMOTE_BRIDGE__ === bridge) delete w.__MYAGENT_REMOTE_BRIDGE__;
    };
  }, []);

  const handleExport = async (kind: 'md' | 'html') => {
    if (!currentSession) return;
    const content = kind === 'md' ? sessionToMarkdown(currentSession) : sessionToHtml(currentSession);
    const ext = kind === 'md' ? 'md' : 'html';
    const safe = (currentSession.title || 'export').replace(/[\\/:"*?<>|]/g, '_');
    await window.electron.saveTextFile({
      defaultName: `${safe}.${ext}`,
      content,
      filters:
        kind === 'md'
          ? [{ name: 'Markdown', extensions: ['md'] }]
          : [{ name: 'HTML', extensions: ['html', 'htm'] }],
    });
  };

  const handleSend = async () => {
    if ((!input.trim() && attachments.length === 0) || !currentSessionId) return;

    cancelVoiceReply();
    if (!sendFromVoiceWakeRef.current) {
      voiceWakeLoopRef.current = false;
    }
    sendFromVoiceWakeRef.current = false;

    const activeModel = getActiveModel();
    if (!activeModel) {
      alert(t('chat.configureModel'));
      return;
    }

    /** 全程固定会话 id，避免压缩异步期间切会话写串 */
    const sendSessionId = currentSessionId;
    if (!tryClaimSessionSend(sendSessionId)) return;

    const uploadedFiles: FileInfo[] = [];

    try {
      if (attachments.length > 0) {
        let uploadFailed = 0;
        for (const file of attachments) {
          try {
            const buffer = await file.arrayBuffer();
            const info = await window.electron.uploadFile({
              name: file.name,
              buffer: Array.from(new Uint8Array(buffer)),
              type: file.type,
              size: file.size,
            });
            uploadedFiles.push(info);
          } catch (e) {
            console.error('上传附件失败', e);
            uploadFailed += 1;
          }
        }
        if (uploadedFiles.length === 0) {
          window.alert(uiLocale === 'en' ? 'Attachment upload failed. Please try again.' : '附件上传失败，请重试。');
          clearLoadingForSession(sendSessionId);
          return;
        }
        if (uploadFailed > 0) {
          window.alert(
            uiLocale === 'en'
              ? `${uploadFailed} attachment(s) failed to upload and were skipped.`
              : `有 ${uploadFailed} 个附件上传失败，已忽略失败项继续发送。`
          );
        }
      }

      const att = t('chat.attachment');
      const textContent = input.trim() || (uploadedFiles.length > 0 ? att : '');

      let priorMessages =
        useChatStore.getState().sessions.find((s) => s.id === sendSessionId)?.messages ?? messages;

      stickToBottomRef.current = true;
      const webOn = currentSession
        ? effectiveWebEnabled(currentSession, webSearchEnabled)
        : webSearchEnabled;
      const ensured = await ensureContextBeforeSend({
        sessionId: sendSessionId,
        priorMessages,
        draftInput: textContent,
        model: activeModel,
        locale: uiLocale === 'en' ? 'en' : 'zh',
        summaryTitle: t('chat.contextSummaryTitle'),
        injectExtras: resolveInjectExtras({ webEnabled: webOn }),
      });
      priorMessages = ensured.priorMessages;
      if (ensured.didCompress) {
        requestAnimationFrame(() => {
          const el = scrollContainerRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        });
      }

      if (priorMessages.length === 0) {
        const title = (textContent === att ? t('chat.attachmentTitle') : textContent) || t('session.newTitle');
        updateSessionTitle(
          sendSessionId,
          title.length > 15 ? title.substring(0, 15) + '...' : title
        );
      }

      const userMessage: Message = {
        id: Date.now().toString(),
        role: 'user',
        content: textContent,
        files: uploadedFiles.length > 0 ? uploadedFiles : undefined,
        timestamp: Date.now(),
        model: activeModel.name,
      };

      addMessage(sendSessionId, userMessage);
      setInput('');
      setAttachments([]);
      setAttachmentPreviews({});
      requestAnimationFrame(() => inputAreaRef.current?.focus());

      if (
        addFullTextBypassIfNeeded({
          sessionId: sendSessionId,
          modelName: activeModel.name,
          textContent,
          hasAttachments: uploadedFiles.length > 0,
        })
      ) {
        return;
      }

      await runModelReply(sendSessionId, priorMessages, userMessage, activeModel);
    } catch (e) {
      clearLoadingForSession(sendSessionId);
      throw e;
    }
  };

  const handleSubmitEditedMessage = async (sourceMessage: Message, nextContent: string) => {
    const textContent = nextContent.trim();
    if (!textContent || !currentSessionId) return;

    const activeModel = getActiveModel();
    if (!activeModel) {
      alert(t('chat.configureModel'));
      return;
    }

    const sendSessionId = currentSessionId;
    const sourceIndex = messages.findIndex((m) => m.id === sourceMessage.id);
    if (sourceIndex < 0) {
      return;
    }
    if (!tryClaimSessionSend(sendSessionId)) return;

    let priorMessages = messages.slice(0, sourceIndex);

    try {
      stickToBottomRef.current = true;
      const webOn = currentSession
        ? effectiveWebEnabled(currentSession, webSearchEnabled)
        : webSearchEnabled;
      const ensured = await ensureContextBeforeSend({
        sessionId: sendSessionId,
        priorMessages,
        draftInput: textContent,
        model: activeModel,
        locale: uiLocale === 'en' ? 'en' : 'zh',
        summaryTitle: t('chat.contextSummaryTitle'),
        editSourceMessageId: sourceMessage.id,
        injectExtras: resolveInjectExtras({ webEnabled: webOn }),
      });
      priorMessages = ensured.priorMessages;

      const latest = useChatStore.getState().sessions.find((s) => s.id === sendSessionId)?.messages ?? messages;
      const latestSourceIndex = latest.findIndex((m) => m.id === sourceMessage.id);
      if (latestSourceIndex < 0) {
        clearLoadingForSession(sendSessionId);
        return;
      }
      priorMessages = latest.slice(0, latestSourceIndex);

      const userMessage: Message = {
        ...sourceMessage,
        role: 'user',
        content: textContent,
        timestamp: Date.now(),
        model: activeModel.name,
      };

      const staleMessageIds = latest.slice(latestSourceIndex + 1).map((m) => m.id);
      updateMessage(sendSessionId, sourceMessage.id, {
        content: textContent,
        timestamp: userMessage.timestamp,
        model: activeModel.name,
      });
      if (staleMessageIds.length > 0) removeMessages(sendSessionId, staleMessageIds);
      setEditingMessageId(null);

      if (
        addFullTextBypassIfNeeded({
          sessionId: sendSessionId,
          modelName: activeModel.name,
          textContent,
          hasAttachments: Boolean(sourceMessage.files?.length),
        })
      ) {
        return;
      }

      await runModelReply(sendSessionId, priorMessages, userMessage, activeModel);
    } catch (e) {
      clearLoadingForSession(sendSessionId);
      throw e;
    }
  };

  /** 每次渲染同步最新 handleSend 到 ref */
  handleSendRef.current = () => {
    void handleSend();
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter') return;
    if (e.shiftKey) return;
    const native = e.nativeEvent;
    if (native.isComposing || imeComposingRef.current) return;
    if ((native as KeyboardEvent).keyCode === 229) return;
    e.preventDefault();
    void handleSend();
  };

  const webEffective =
    currentSession != null
      ? effectiveWebEnabled(currentSession, webSearchEnabled)
      : false;

  const attachmentStripH = 80;

  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : undefined;

  /** 流式：最后是助手且无正文时需要「···」，但若已有思考内容则在主气泡内显示，避免双重气泡 */
  const assistantNeedsDots =
    isStreaming && lastMsg?.role === 'assistant' && !(lastMsg.content ?? '').trim().length;
  const thinkingVisibleWhileWaiting =
    assistantNeedsDots && !!(lastMsg?.reasoning ?? '').trim().length;

  const showTypingDots =
    isCurrentSessionLoading &&
    (lastMsg?.role === 'user' || (assistantNeedsDots && !thinkingVisibleWhileWaiting));

  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, currentSessionId, showTypingDots, vectorRagStatus, footerH, attachments.length, isCompressingCurrent]);

  return (
    <div
      className="flex flex-col h-full min-h-0"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {currentSessionId && currentSession && (
        <div className="shrink-0 flex flex-wrap items-center gap-2 border-b border-stone-600/20 px-6 py-2 dark:border-white/10 bg-stone-100/50 dark:bg-slate-900/40">
          <div className="flex items-center gap-2.5 text-xs text-stone-600 dark:text-slate-400">
            <div className="flex items-center gap-1.5">
              <FiGlobe size={14} className="shrink-0" aria-hidden />
              <span>{t('chat.web')}</span>
            </div>
            <IosSwitch
              checked={webEffective}
              aria-label={t('chat.webSwitch')}
              onChange={(v) => setSessionWebOverride(currentSessionId, v ? 'on' : 'off')}
            />
          </div>
          <div className="ml-auto flex items-center gap-1">
            {selectionMode ? (
              <>
                <span className="mr-1 text-xs text-stone-500 dark:text-slate-400">
                  {t('chat.selectedCount', { count: selectedMessageIds.size })}
                </span>
                <button
                  type="button"
                  onClick={deleteSelectedMessages}
                  disabled={selectedMessageIds.size === 0 || isCurrentSessionLoading}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-red-600 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-45 dark:text-red-300 dark:hover:bg-red-950/45"
                  title={t('chat.deleteSelected')}
                >
                  <FiTrash2 size={14} /> {t('chat.deleteSelected')}
                </button>
                <button
                  type="button"
                  onClick={cancelSelection}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-stone-600 hover:bg-stone-200/80 dark:text-slate-300 dark:hover:bg-slate-800"
                  title={t('chat.cancelSelect')}
                >
                  <FiX size={14} /> {t('chat.cancelSelect')}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => startSelection()}
                disabled={messages.length === 0 || isCurrentSessionLoading}
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-stone-600 hover:bg-stone-200/80 disabled:cursor-not-allowed disabled:opacity-45 dark:text-slate-300 dark:hover:bg-slate-800"
                title={t('chat.selectMessages')}
              >
                <FiCheckSquare size={14} /> {t('chat.selectMessages')}
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleExport('md')}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-stone-600 hover:bg-stone-200/80 dark:text-slate-300 dark:hover:bg-slate-800"
              title={t('chat.export.md')}
            >
              <FiDownload size={14} /> MD
            </button>
            <button
              type="button"
              onClick={() => void handleExport('html')}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-stone-600 hover:bg-stone-200/80 dark:text-slate-300 dark:hover:bg-slate-800"
              title={t('chat.export.html')}
            >
              <FiDownload size={14} /> HTML
            </button>
          </div>
        </div>
      )}

      {vectorRagStatus?.tone === 'error' ? (
        <div
          className={
            'shrink-0 border-b px-6 py-2.5 text-[11px] leading-relaxed antialiased ' +
            'border-red-200/80 bg-red-50 text-red-900 dark:border-red-500/35 dark:bg-red-950/50 dark:text-red-100'
          }
          role="alert"
        >
          {vectorRagStatus.text}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollContainerRef}
        data-gesture-scroll-target="chat"
        className="min-h-0 flex-1 overflow-y-auto px-8 py-4 space-y-4"
        style={{
          paddingBottom: `calc(${footerH + (attachments.length > 0 ? attachmentStripH : 0)}px + env(safe-area-inset-bottom, 0px))`,
        }}
      >
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-64 text-stone-400 dark:text-slate-500">
            <p className="text-lg">{t('chat.emptyChat')}</p>
          </div>
        )}

        {messages.map((message, index) => {
          const reasoningTrim = (message.reasoning ?? '').trim();
          const hideEmptyStreamBubble =
            isStreaming &&
            message.role === 'assistant' &&
            message.id === streamingTargetAssistantId &&
            !(message.content ?? '').trim().length &&
            !reasoningTrim.length;
          if (hideEmptyStreamBubble) return <React.Fragment key={message.id} />;
          return (
          <React.Fragment key={message.id}>
            {index === newConversationDividerIndex && (
              <div className="flex items-center gap-3 py-1" role="separator" aria-label={t('chat.newConversationDivider')}>
                <div className="h-px flex-1 bg-stone-300/60 dark:bg-slate-600/50" />
                <span className="text-[10px] font-medium text-stone-400 dark:text-slate-500 whitespace-nowrap">
                  {t('chat.newConversationDivider')}
                </span>
                <div className="h-px flex-1 bg-stone-300/60 dark:bg-slate-600/50" />
              </div>
            )}
          <MessageItem
            key={message.id}
            message={message}
              onEdit={message.role === 'user' ? handleEditMessage : undefined}
              editing={editingMessageId === message.id}
              onSubmitEdit={handleSubmitEditedMessage}
              onCancelEdit={cancelEdit}
              selectionMode={selectionMode}
              selected={selectedMessageIds.has(message.id)}
              onToggleSelect={toggleMessageSelection}
              onStartSelect={startSelection}
              conversationStreaming={isStreaming}
              streamingAssistantId={streamingTargetAssistantId}
              showInlineStreamPlaceholder={
                !!isStreaming &&
                message.role === 'assistant' &&
                message.id === streamingTargetAssistantId &&
                !(message.content ?? '').trim().length &&
                !!(message.reasoning ?? '').trim().length
              }
              conversationGallery={conversationGallery}
              onOpenConversationGallery={(messageId, fileIndex) => {
                const idx = findConversationGalleryIndex(conversationGallery, messageId, fileIndex);
                if (idx >= 0) {
                  setConversationGalleryIdx(idx);
                  setConversationGalleryNonce((n) => n + 1);
                }
              }}
              imageGenProgress={
                imageGenProgress?.messageId === message.id
                  ? { current: imageGenProgress.current, total: imageGenProgress.total }
                  : message.imageGenProgress
              }
            />
          </React.Fragment>
          );
        })}

        {showTypingDots && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 text-stone-500 dark:text-slate-500 text-sm px-5 py-3.5 bg-stone-100 dark:bg-slate-800 rounded-2xl rounded-tl-sm border border-stone-300/45 dark:border-white/5">
              <div className="flex gap-1">
                <span className="animate-bounce" style={{ animationDelay: '0ms' }}>
                  ·
                </span>
                <span className="animate-bounce" style={{ animationDelay: '150ms' }}>
                  ·
                </span>
                <span className="animate-bounce" style={{ animationDelay: '300ms' }}>
                  ·
                </span>
              </div>
            </div>
          </div>
        )}

        {isCompressingCurrent ? (
          <div
            className="flex items-center gap-3 py-2"
            role="status"
            aria-live="polite"
            aria-label={t('chat.compressingContext')}
          >
            <div className="h-px flex-1 bg-stone-300/60 dark:bg-slate-600/50" />
            <span className="inline-flex items-center gap-1.5 text-[10px] font-medium text-stone-500 dark:text-slate-400 whitespace-nowrap">
              <FiLoader size={12} className="animate-spin shrink-0 opacity-80" aria-hidden />
              {t('chat.compressingContext')}
            </span>
            <div className="h-px flex-1 bg-stone-300/60 dark:bg-slate-600/50" />
          </div>
        ) : null}

        <div ref={messagesEndRef} />
      </div>
      <AgentBrowserPanel />
      </div>

      {isDragging && (
        <div className="fixed inset-0 z-50 bg-primary-500/10 backdrop-blur-sm flex items-center justify-center border-4 border-dashed border-primary-400 m-4 rounded-2xl">
          <p className="text-2xl font-bold text-primary-600 dark:text-primary-400">{t('chat.dropHint')}</p>
        </div>
      )}

      <div
        className="fixed bottom-0 right-0 z-30 flex w-[calc(100%-256px)] min-w-0 flex-col border-t border-stone-600/38 bg-stone-200/92 backdrop-blur-xl dark:border-white/10 dark:bg-[#0B1120]/80"
        style={{ left: 256, paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        {attachments.length > 0 && (
          <div
            className="flex shrink-0 flex-wrap justify-start gap-2 border-b border-stone-600/25 bg-transparent px-6 py-1.5 dark:border-white/10"
            aria-label={t('chat.attachments')}
          >
            {attachments.map((file, index) => {
              const preview = attachmentPreviews[file.name];
              const isImage = file.type.startsWith('image/');
              const showThumb = isImage && !!preview;
              return (
                <div
                  key={`${file.name}-${index}`}
                  className="relative flex w-[92px] shrink-0 flex-col items-center gap-1 rounded-lg border border-primary-400/55 bg-transparent px-1 pb-1.5 pt-1 dark:border-primary-500/45"
                >
                  <button
                    type="button"
                    onClick={() => removeAttachment(index)}
                    className="absolute -right-1 -top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-stone-400/50 bg-stone-100 text-[11px] leading-none text-stone-600 shadow-sm hover:bg-stone-200 dark:border-white/20 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                    title={t('chat.removeFile')}
                  >
                    ×
                  </button>
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-md border-2 border-primary-500/70 bg-stone-100/80 shadow-sm dark:border-primary-400/60 dark:bg-slate-900/40">
                    {showThumb ? (
                      <img src={preview} alt="" className="h-full w-full object-cover" />
                    ) : isImage ? (
                      <FiImage className="text-stone-400 dark:text-slate-500" size={22} aria-hidden />
                    ) : (
                      <FiFile className="text-stone-600 dark:text-slate-300" size={22} aria-hidden />
                    )}
                  </div>
                  <span className="w-full truncate px-0.5 text-center text-[10px] font-medium leading-tight text-stone-800 dark:text-slate-100">
                    {file.name}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <div
          className="relative box-border flex min-h-0 w-full min-w-0 flex-col gap-2 px-6 py-1.5 sm:py-2"
          style={{ minHeight: footerH }}
        >
          {speechInputEnabled && speechDictation.banner ? (
            <div className="flex shrink-0 items-center justify-between gap-2 rounded-lg border border-amber-400/35 bg-amber-50/90 px-3 py-1.5 text-xs text-amber-950 dark:border-amber-600/35 dark:bg-amber-950/45 dark:text-amber-50">
              <span className="min-w-0 leading-snug">{speechDictation.banner}</span>
              <button
                type="button"
                className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium opacity-80 hover:opacity-100"
                onClick={() => speechDictation.clearBanner()}
              >
                {t('app.close')}
              </button>
            </div>
          ) : null}
        {(() => {
          const active = getActiveModel();
          /** 满格 = 压缩触发线（soft×95%），与发送前门禁对齐 */
          const fullAt = resolveContextProgressFullChars(active);
          const softLimit = resolveContextSoftLimitChars(active);
          const webOn = currentSession
            ? effectiveWebEnabled(currentSession, webSearchEnabled)
            : webSearchEnabled;
          const extras = resolveInjectExtras({ webEnabled: webOn });
          const overhead = estimateInjectedPayloadOverheadChars(extras);
          const stored = estimateSessionChars(messages, input);
          const totalLength = stored + overhead;
          const fillPerc = Math.min((totalLength / Math.max(1, fullAt)) * 100, 100);
          const isNearLimit = fillPerc > 80;
          const truncateRisk = messagesExceedSanitizeLimit(messages);
          const softPct = Math.round(Math.min((totalLength / Math.max(1, softLimit)) * 100, 100));
          const baseHint = t('chat.contextUsageHint', {
            used: Math.round(totalLength / 1000),
            limit: Math.round(softLimit / 1000),
            pct: softPct,
          });
          const title = truncateRisk ? `${baseHint} · ${t('chat.contextSanitizeWarn')}` : baseHint;
          return totalLength > 0 ? (
            <div
                className={`absolute top-0 left-0 h-[2px] transition-all duration-300 ${
                  isNearLimit || truncateRisk ? 'bg-orange-500' : 'bg-gradient-to-r from-primary-400 to-teal-500'
                }`}
              style={{ width: `${fillPerc}%` }}
              title={title}
            />
          ) : null;
        })()}

          <input
            type="file"
            multiple
            ref={fileInputRef}
            onChange={handleFileInput}
            className="hidden"
            accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.xlsm,.md,.markdown,.txt,.csv,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
          />

          <div className="flex min-h-[2.5rem] w-full min-w-0 flex-1 items-center gap-2">
          <div className="flex min-h-10 min-w-0 flex-1 items-center gap-1 rounded-2xl border border-stone-400/28 bg-stone-100/95 py-0 pl-1.5 pr-1 shadow-sm transition-all focus-within:border-primary-500 focus-within:ring-2 focus-within:ring-primary-500/50 dark:border-slate-700 dark:bg-slate-800/80">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-all ${
                  attachments.length > 0
                    ? 'bg-primary-100/80 text-primary-600 dark:bg-primary-900/30'
                    : 'text-stone-500 hover:bg-stone-300/45 dark:text-slate-500 dark:hover:bg-slate-700'
                }`}
                title={t('chat.uploadFile')}
            >
              <FiPaperclip size={14} />
            </button>
              {speechInputEnabled ? (
                <button
                  type="button"
                  aria-pressed={speechDictation.listening}
                  aria-busy={speechDictation.starting}
                  aria-label={
                    speechDictation.listening
                      ? t('chat.voiceStopTitle')
                      : speechDictation.starting
                        ? t('chat.voiceStarting')
                        : voiceWake.listening
                          ? t('chat.voiceWakeListening', { phrase: voiceWakePhrase.trim() || voiceWakePhrase })
                          : t('chat.voiceInput')
                  }
                  disabled={
                    isSessionBusy || !speechDictation.supported || speechDictation.starting
                  }
                  onClick={() => {
                    if (!speechDictation.listening) {
                      voiceWakeLoopRef.current = false;
                    }
                    speechDictation.toggle();
                  }}
                  title={
                    speechDictation.listening
                      ? t('chat.voiceListening')
                      : speechDictation.starting
                        ? t('chat.voiceStarting')
                        : !speechDictation.supported
                          ? t('chat.speechNotSupported')
                          : voiceWake.listening
                          ? t('chat.voiceWakeListeningHint', { phrase: voiceWakePhrase.trim() || voiceWakePhrase })
                          : voiceWake.starting
                            ? t('chat.voiceWakeStarting')
                            : t('chat.voiceInput')
                  }
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-all [&_svg]:pointer-events-none ${
                    speechDictation.listening
                      ? 'bg-red-600 text-white shadow-sm shadow-red-500/25 animate-pulse'
                      : speechDictation.starting
                        ? 'cursor-wait text-primary-600 dark:text-primary-400'
                        : isSessionBusy || !speechDictation.supported
                          ? 'cursor-not-allowed text-stone-400 dark:text-slate-600'
                          : voiceWake.listening
                            ? 'text-primary-600 ring-1 ring-primary-400/60 dark:text-primary-400 dark:ring-primary-500/50'
                            : voiceWake.starting
                              ? 'cursor-wait text-primary-600 dark:text-primary-400'
                              : 'text-stone-600 hover:bg-stone-300/55 dark:text-slate-400 dark:hover:bg-slate-700'
                  }`}
                >
                  {speechDictation.starting || voiceWake.starting ? (
                    <FiLoader size={15} className="animate-spin" aria-hidden />
                  ) : (
                    <FiMic size={15} aria-hidden />
                  )}
                </button>
              ) : null}
            <textarea
                ref={inputAreaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
                onCompositionStart={() => {
                  imeComposingRef.current = true;
                }}
                onCompositionEnd={() => {
                  imeComposingRef.current = false;
                }}
              onKeyDown={handleInputKeyDown}
                placeholder={t('chat.inputPlaceholder')}
                className="box-border min-h-10 w-full min-w-0 flex-1 resize-none bg-transparent py-2.5 pl-1 pr-0.5 leading-5 text-stone-800 placeholder-stone-500/70 focus:outline-none dark:text-slate-100 text-[clamp(0.8125rem,0.55vw+0.68rem,0.9375rem)]"
              rows={1}
                style={{ maxHeight: 'min(28vh, 9rem)' }}
              disabled={isSessionBusy}
            />
            <div className="ml-0.5 flex shrink-0 items-center self-stretch border-l border-stone-400/25 pl-1 dark:border-slate-600">
              <ModelSelector compact />
            </div>
          </div>
            {isCurrentSessionLoading && (isStreaming || imageGenProgress) ? (
          <button
            type="button"
                onClick={handleStop}
                className="inline-flex h-10 shrink-0 items-center justify-center gap-1 rounded-xl border border-stone-400/50 bg-stone-100 px-4 text-sm font-medium text-stone-800 hover:bg-stone-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
                title={t('chat.stopTitle')}
              >
                <FiSquare size={12} className="shrink-0" />
                {t('chat.stop')}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void handleSend()}
            disabled={!input.trim() && attachments.length === 0}
            className={`inline-flex h-10 shrink-0 items-center justify-center rounded-xl px-5 text-sm font-medium transition-all ${
              input.trim() || attachments.length > 0
                ? 'bg-primary-600 text-white shadow-md shadow-primary-500/20 hover:bg-primary-700'
                : 'cursor-not-allowed bg-stone-300 text-stone-500 dark:bg-slate-700 dark:text-slate-500'
            }`}
              title={t('chat.sendTitle')}
          >
              {t('chat.send')}
          </button>
        </div>
        </div>
      </div>
      {conversationGalleryIdx !== null && conversationGallery.length > 0 ? (
        <ConversationImageGalleryModal
          key={`${currentSessionId ?? 'sess'}-${conversationGalleryNonce}`}
          slides={conversationGallery}
          startIndex={conversationGalleryIdx}
          onClose={() => setConversationGalleryIdx(null)}
        />
      ) : null}
    </div>
  );
};

export default ChatWindow;
