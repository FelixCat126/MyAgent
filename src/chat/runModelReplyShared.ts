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
  imageReferencePathsFromFiles,
  createDocumentArtifactsFromMarkdown,
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
  appendFn: (sessionId: string, msgId: string, chunk: string) => void
) {
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
    syncImgGenUi: (v) => syncImgGenUi(ui, sendSessionId, v),
    imageGenCancelledRef: ui.imageGenCancelledRef,
    onImage: (image) => appendGeneratedImageToAssistant(ui, sendSessionId, assistantId, image),
  });
  const { content, files } = await postProcessAssistantContent(
    rawText,
    activeModel,
    ui.inlineImageIndexRef.current,
    ui.setInlineImageIndex,
    {
      imageGenHooks,
      referenceImages: imageReferencePathsFromFiles(userMessage.files),
      userPromptContext: userMessage.content,
      plannedIntent,
      shouldCancel: () => ui.imageGenCancelledRef.current,
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
}): Promise<void> {
  const { ui, sendSessionId, assistantId, rawText, userText, exportHint, extraUpdate } = opts;
  const artifactBody = stripGenerateImageArtifactsForDisplay(rawText).trim();
  const artifactFiles = await createDocumentArtifactsFromMarkdown(
    artifactBody,
    documentExportFormatsFromHint(exportHint),
    documentArtifactBaseNameFromContent(artifactBody, documentArtifactBaseName(userText))
  );
  ui.updateMessage(sendSessionId, assistantId, {
    content: artifactFiles.length ? ui.t('chat.documentReady') : ui.t('chat.documentWriteFailed'),
    ...(extraUpdate ?? {}),
    exportHint,
    files: artifactFiles.length ? artifactFiles : undefined,
  });
}
