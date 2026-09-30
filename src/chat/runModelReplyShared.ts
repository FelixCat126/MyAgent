import { generateDocumentArtifacts } from './documentArtifacts';
import { imageTaskWasCancelled, replyRunWasCancelled } from './imageTaskState';
import { resolveImageReferences } from '../utils/imageReferences';
import type { FileInfo, Message, ModelConfig } from '../types';
import { useChatStore } from '../store/chatStore';
import { StreamingSpeechReader } from '../utils/streamingSpeech';
import { extractGenerateImageCalls, stripGenerateImageArtifactsForDisplay } from '../utils/toolCalls';
import { planImageIntent, type ImageIntent } from '../utils/imageIntentPlanner';
import {
  documentArtifactBaseName,
  documentArtifactBaseNameFromContent,
  documentExportFormatsFromHint,
} from '../utils/documentExportIntent';
import {
  postProcessAssistantContent,
} from './imageGenAssist';
import { makeImageGenHooks } from './makeImageGenHooks';
import type { RunModelReplyUi } from './runModelReplyTypes';

export function syncImgGenUi(
  ui: RunModelReplyUi,
  sendSessionId: string,
  v: { current: number; total: number; messageId: string } | null
): void {
  if (v) {
    ui.imageGenSyncRef.current = { sessionId: sendSessionId, messageId: v.messageId };
    ui.setImageGenProgress(v);
    ui.updateMessage(sendSessionId, v.messageId, {
      imageGenProgress: { current: v.current, total: v.total },
    });
    return;
  }
  ui.setImageGenProgress(null);
  const p = ui.imageGenSyncRef.current;
  if (p && p.sessionId === sendSessionId) {
    ui.updateMessage(p.sessionId, p.messageId, { imageGenProgress: undefined });
    ui.imageGenSyncRef.current = null;
  }
}

export function appendGeneratedImageToAssistant(
  ui: RunModelReplyUi,
  sendSessionId: string,
  assistantId: string,
  image: { url: string; path: string; width: number; height: number }
): void {
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
  ui.updateMessage(sendSessionId, assistantId, { files: [...prev, file] });
}

export function mergeAssistantFiles(
  sendSessionId: string,
  assistantId: string,
  incoming?: FileInfo[]
): FileInfo[] | undefined {
  const sess = useChatStore.getState().sessions.find((s) => s.id === sendSessionId);
  const msg = sess?.messages.find((m) => m.id === assistantId);
  const merged: FileInfo[] = [...((msg?.files ?? []) as FileInfo[])];
  for (const f of incoming ?? []) {
    if (!merged.some((x) => x.path === f.path)) merged.push(f);
  }
  return merged.length ? merged : undefined;
}

/**
 * 自适应流式渲染：小缓冲稳定推进，大缓冲自动追赶。
 * 同一帧只写一次 store，避免 Markdown 频繁重绘；结束时可自然排空而非整段闪现。
 */

export interface StreamLifecycleOptions {
  /** 流式开始前调用；通常用于 setIsStreaming(true) + setStreamingTargetAssistantId(id) */
  onBegin?: (assistantId: string) => void;
  /** 成功后调用；通常用于清空 streaming 状态（保留 loading 集合清理由 onFinalize 决定） */
  onClearStreamingUi?: () => void;
  /** 最终清理：清 loading、ref 重置；通常 finally 调用 */
  onFinalize: (assistantId: string) => void;
  /** 错误回调：拿到错误后通常插入"流式中断"提示消息 */
  onError?: (err: unknown) => void;
  /** 是否在被 catch 后还调用 onClearStreamingUi（默认 true） */
  clearUiOnError?: boolean;
}

/**
 * 流式状态生命周期模板：把 try/finally 收尾统一抽到此处。
 *
 * 行为契约：
 * - 调用 work()
 * - 不抛错：opts.onClearStreamingUi?.() → opts.onFinalize(assistantId) → 返回结果
 * - 抛错：opts.onClearStreamingUi?.()（当 clearUiOnError !== false） → opts.onFinalize(assistantId) → 重新抛错
 * - 不抛错时若 work 返回 undefined 同样返回 undefined
 *
 * 顺序严格按原 try/finally 现场复刻；调用方应把所有副作用（setIsStreaming、clearLoadingForSession、
 * setStreamingTargetAssistantId、streamingAssistantIdRef.current = null 等）按原顺序写入 onFinalize。
 */
export async function withStreamLifecycle<T>(
  assistantId: string,
  opts: StreamLifecycleOptions,
  work: () => Promise<T>
): Promise<T | undefined> {
  let result: T | undefined;
  let threw: unknown;
  try {
    result = await work();
  } catch (err) {
    threw = err;
  }
  if (threw === undefined) {
    opts.onClearStreamingUi?.();
    opts.onFinalize(assistantId);
    return result;
  }
  if (opts.clearUiOnError !== false) {
    opts.onClearStreamingUi?.();
  }
  opts.onError?.(threw);
  opts.onFinalize(assistantId);
  throw threw;
}

export function createAnimStream(
  sendSessionId: string,
  assistantId: string,
  appendFn: (sessionId: string, msgId: string, chunk: string) => void,
  options: { pace?: 'answer' | 'reasoning'; startPaused?: boolean } = {}
) {
  let buffer = '';
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let finishPromise: Promise<void> | null = null;
  let resolveFinish: (() => void) | null = null;
  let paused = Boolean(options.startPaused);

  const isReasoning = options.pace === 'reasoning';
  /** 正文约 50 个中文视觉单位/秒；思考约 100 个/秒，仍逐字推进。 */
  const BASE_TICK_MS = isReasoning ? 10 : 20;

  const visualCost = (grapheme: string): number => {
    if (/^\s$/u.test(grapheme)) return 0.3;
    /** Markdown 控制符跟相邻字符一起出现，减少 `**` / ``` 半截闪烁。 */
    if (/^[`*_#>~\[\](){}|\\]$/u.test(grapheme)) return 0.35;
    /** 英文/数字比汉字窄，但仍限速，避免一行文字瞬间横向扫过。 */
    if (/^[\x20-\x7e]$/u.test(grapheme)) return 0.65;
    return 1;
  };

  const takeComfortableChunk = (): string => {
    /** 固定视觉预算，不因模型返回过快或缓冲积压而突然提速。 */
    const budget = 1;
    let spent = 0;
    let consumedUnits = 0;
    let consumedCodeUnits = 0;
    /** for...of 按 Unicode code point 迭代且最多读取 8 个，避免长缓冲每拍整段复制。 */
    for (const grapheme of buffer) {
      const cost = visualCost(grapheme);
      if (consumedUnits > 0 && spent + cost > budget) break;
      spent += cost;
      consumedUnits += 1;
      consumedCodeUnits += grapheme.length;
      if (consumedUnits >= 8) break;
    }
    const chunk = buffer.slice(0, consumedCodeUnits);
    buffer = buffer.slice(consumedCodeUnits);
    return chunk;
  };

  const nextDelayAfter = (chunk: string): number => {
    /** 思考过程优先快速连续输出，不在标点处额外等待。 */
    if (isReasoning) return BASE_TICK_MS;
    const units = Array.from(chunk);
    const tail = units[units.length - 1] ?? '';
    if (tail === '\n') return BASE_TICK_MS + 70;
    if (/[。！？]/u.test(tail)) return BASE_TICK_MS + 75;
    if (/[，、；：]/u.test(tail)) return BASE_TICK_MS + 24;
    if (/[.!?]/u.test(tail) && (!buffer || /^\s/u.test(buffer))) return BASE_TICK_MS + 60;
    if (/[,;:]/u.test(tail) && /^\s/u.test(buffer)) return BASE_TICK_MS + 20;
    return BASE_TICK_MS;
  };

  const settleFinish = () => {
    if (buffer || timerId !== null || !resolveFinish) return;
    const resolve = resolveFinish;
    resolveFinish = null;
    finishPromise = null;
    resolve();
  };

  const cancelScheduled = () => {
    if (timerId !== null) clearTimeout(timerId);
    timerId = null;
  };

  const drain = () => {
    timerId = null;
    if (!buffer) {
      settleFinish();
      return;
    }
    const chunk = takeComfortableChunk();
    appendFn(sendSessionId, assistantId, chunk);
    if (buffer) {
      schedule(nextDelayAfter(chunk));
    } else {
      settleFinish();
    }
  };

  const schedule = (delayMs = BASE_TICK_MS) => {
    if (paused || timerId !== null) return;
    timerId = setTimeout(drain, delayMs);
  };

  const flush = () => {
    cancelScheduled();
    if (!buffer) return;
    const chunk = buffer;
    buffer = '';
    appendFn(sendSessionId, assistantId, chunk);
    settleFinish();
  };

  return {
    push(d: string) {
      if (!d) return;
      buffer += d;
      schedule();
    },
    flush,
    resume() {
      if (!paused) return;
      paused = false;
      schedule();
    },
    finish(): Promise<void> {
      if (!buffer) {
        cancelScheduled();
        settleFinish();
        return Promise.resolve();
      }
      if (!finishPromise) {
        finishPromise = new Promise<void>((resolve) => {
          resolveFinish = resolve;
        });
      }
      schedule();
      return finishPromise;
    },
  };
}

/* =====================================================================
 * 三条回复路径（SSE 流式 / 文档流式 / Agent / 同步）共享的编排 helper。
 * 以下每个函数都曾是三处逐字复制的样板，统一后行为单点维护。
 * ===================================================================*/

/**
 * 若当前叶是「空助手气泡」（重新生成 fork 预置），复用其 id；否则新建。
 * 避免 fork 后再 beginAssistantStream 又挂一层子气泡。
 */
export function resolveOrCreateAssistantBubble(
  ui: RunModelReplyUi,
  sendSessionId: string,
  preferredId: string,
  patch: {
    modelName: string;
    content?: string;
    reasoning?: string;
    exportHint?: Message['exportHint'];
  }
): string {
  const sess = useChatStore.getState().sessions.find((s) => s.id === sendSessionId);
  const leafId = sess?.activeLeafId ?? null;
  const leaf = leafId ? sess?.messages.find((m) => m.id === leafId) : undefined;
  const reusable =
    leaf?.role === 'assistant' &&
    !(leaf.content ?? '').trim() &&
    !(leaf.reasoning ?? '').trim();
  if (reusable && leaf) {
    ui.updateMessage(sendSessionId, leaf.id, {
      content: patch.content ?? '',
      ...(patch.reasoning !== undefined ? { reasoning: patch.reasoning } : {}),
      ...(patch.exportHint ? { exportHint: patch.exportHint } : {}),
      timestamp: Date.now(),
      model: patch.modelName,
    });
    return leaf.id;
  }
  ui.addMessage(sendSessionId, {
    id: preferredId,
    role: 'assistant',
    content: patch.content ?? '',
    ...(patch.reasoning ? { reasoning: patch.reasoning } : {}),
    ...(patch.exportHint ? { exportHint: patch.exportHint } : {}),
    timestamp: Date.now(),
    model: patch.modelName,
  });
  return preferredId;
}

/** 流式启动样板：复位错误/取消标记 → 登记流式 ref → 置 UI 流式态 → 插入/复用空气泡 */
export function beginAssistantStream(
  ui: RunModelReplyUi,
  sendSessionId: string,
  opts: { assistantId: string; modelName: string; exportHint?: Message['exportHint'] }
): string {
  const assistantId = resolveOrCreateAssistantBubble(ui, sendSessionId, opts.assistantId, {
    modelName: opts.modelName,
    ...(opts.exportHint ? { exportHint: opts.exportHint } : {}),
  });
  ui.streamHadErrorRef.current = false;
  ui.streamCancelledByUserRef.current = false;
  ui.streamingAssistantIdRef.current = assistantId;
  ui.streamingSessionIdRef.current = sendSessionId;
  ui.setStreamingTargetAssistantId(assistantId);
  ui.setIsStreaming(true);
  return assistantId;
}

/** 流式收尾清理（onFinalize 统一实现） */
export function resetStreamingUi(ui: RunModelReplyUi, sendSessionId: string): void {
  ui.setIsStreaming(false);
  ui.clearLoadingForSession(sendSessionId);
  ui.streamingAssistantIdRef.current = null;
  ui.streamingSessionIdRef.current = null;
  ui.setStreamingTargetAssistantId(null);
}

/** 语音唤醒回复：消费一次性标记并创建 reader；调用方负责 start/push/finish */
export function createVoiceWakeReplyReader(ui: RunModelReplyUi): StreamingSpeechReader | null {
  if (!ui.consumeVoiceWakeReply()) return null;
  ui.speechReaderRef.current?.cancel();
  const reader = new StreamingSpeechReader(ui.locale, {
    onSpeakingChange: ui.setVoiceReplySpeaking,
  });
  ui.speechReaderRef.current = reader;
  return reader;
}

/** 语音唤醒一次性播报：剥离生图残留后整段 push + finish（Agent/同步路径共用） */
export function speakVoiceWakeReplyOnce(ui: RunModelReplyUi, rawText: string): void {
  const reader = createVoiceWakeReplyReader(ui);
  if (!reader) return;
  void (async () => {
    await reader.start();
    const speakBody = stripGenerateImageArtifactsForDisplay(rawText).trim();
    if (speakBody) {
      reader.push(speakBody);
      reader.finish();
    }
  })();
}

/** 生图意图规划（SSE 路径需提前用于取消判断，故独立导出） */
export function planAssistantImageIntent(
  userMessage: Message,
  historyBeforeUser: Message[],
  rawText: string
): ImageIntent {
  return planImageIntent({
    userText: userMessage.content,
    historyBeforeUser,
    assistantText: rawText,
    toolCallCount: extractGenerateImageCalls(rawText).length,
  });
}

/** 生图后处理：hooks 装配 + （可选复用预计算的意图）+ postProcessAssistantContent */
export async function runImagePostProcess(opts: {
  ui: RunModelReplyUi;
  sendSessionId: string;
  assistantId: string;
  rawText: string;
  userMessage: Message;
  activeModel: ModelConfig;
  historyBeforeUser: Message[];
  /** 已预计算的意图；缺省时内部计算 */
  plannedIntent?: ImageIntent;
}): Promise<{ content: string; files: FileInfo[] | undefined; plannedIntent: ImageIntent }> {
  const { ui, sendSessionId, assistantId, rawText, userMessage, activeModel, historyBeforeUser } = opts;
  const plannedIntent =
    opts.plannedIntent ?? planAssistantImageIntent(userMessage, historyBeforeUser, rawText);
  const imageGenHooks = makeImageGenHooks({
    assistantId,
    syncImgGenUi: (v) => { if (!imageTaskWasCancelled(assistantId)) syncImgGenUi(ui, sendSessionId, v); },
    imageGenCancelledRef: ui.imageGenCancelledRef,
    onImage: (image) => { if (!imageTaskWasCancelled(assistantId)) appendGeneratedImageToAssistant(ui, sendSessionId, assistantId, image); },
  });
  const { content, files } = await postProcessAssistantContent(
    rawText,
    activeModel,
    ui.inlineImageIndexRef.current,
    ui.setInlineImageIndex,
    {
      imageGenHooks,
      requestId: assistantId,
      referenceImages: plannedIntent.shouldGenerate ? resolveImageReferences(userMessage, historyBeforeUser) : [],
      userPromptContext: userMessage.content,
      plannedIntent,
      shouldCancel: () => imageTaskWasCancelled(assistantId) || replyRunWasCancelled(sendSessionId, userMessage.id),
    }
  );
  return { content, files, plannedIntent };
}

/** 文档产物生成：strip → createDocumentArtifactsFromMarkdown → ready/failed 更新 */
export async function fulfillDocumentArtifact(opts: {
  ui: RunModelReplyUi;
  sendSessionId: string;
  assistantId: string;
  rawText: string;
  userText: string;
  exportHint: NonNullable<Message['exportHint']>;
  /** 随最终 updateMessage 一并写入的额外字段（如 reasoning） */
  extraUpdate?: Record<string, unknown>;
  shouldCancel?: () => boolean;
}): Promise<void> {
  const { ui, sendSessionId, assistantId, rawText, userText, exportHint, extraUpdate } = opts;
  const artifactBody = stripGenerateImageArtifactsForDisplay(rawText).trim();
  const result = await generateDocumentArtifacts(
    artifactBody,
    documentExportFormatsFromHint(exportHint),
    documentArtifactBaseName(userText, documentArtifactBaseNameFromContent(artifactBody)),
    [],
    () => ui.streamCancelledByUserRef.current || Boolean(opts.shouldCancel?.()),
  );
  ui.updateMessage(sendSessionId, assistantId, {
    ...(extraUpdate ?? {}),
    content: result.cancelled ? ui.t('chat.stoppedBanner') : result.errors.length ? artifactBody : ui.t('chat.documentReady'),
    exportHint: { ...exportHint, sourceContent: artifactBody, status: result.cancelled || result.errors.length ? 'failed' : 'ready', error: result.cancelled ? ui.t('chat.stoppedBanner') : result.errors.join('；') || undefined },
    files: result.files.length ? result.files : undefined,
  });
}
