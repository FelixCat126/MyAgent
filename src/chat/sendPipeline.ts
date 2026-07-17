import type { FileInfo, Message, ModelConfig } from '../types';
import { useChatStore } from '../store/chatStore';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useKnowledgeStore } from '../store/knowledgeStore';
import { FULL_TEXT_DOWNLOAD_BYPASS_REPLY } from './fullTextDownloadBypass';
import { shouldBypassModelForFullTextDownload } from '../utils/documentExportIntent';
import { ensureContextBeforeSend } from './ensureContextBeforeSend';
import { isAttachmentPlaceholder } from '../utils/attachmentPlaceholder';

export type InjectExtras = {
  webEnabled?: boolean;
  ragLikely?: boolean;
  workspaceLikely?: boolean;
  /** 覆盖默认粗估（例如用当前 RAG maxChars） */
  ragMaxChars?: number;
  workspaceMaxChars?: number;
};

/** 从当前 store 推导发送时注入开销（桌面/远端共用） */
export function resolveInjectExtras(opts: { webEnabled: boolean }): InjectExtras {
  const root = useWorkspaceStore.getState().rootPath.trim();
  const maxChars = useWorkspaceStore.getState().maxChars;
  const { vectorRagEnabled, ragMaxInjectChars } = useKnowledgeStore.getState();
  return {
    webEnabled: opts.webEnabled,
    ragLikely: Boolean(root) && vectorRagEnabled,
    workspaceLikely: Boolean(root),
    ragMaxChars: ragMaxInjectChars,
    workspaceMaxChars: maxChars,
  };
}

/**
 * 发送占坑：同会话 loading/compressing 任一忙则拒绝，成功则立刻加入 loading，消除上传期间竞态。
 * 调用方在中止路径必须 clearLoadingForSession。
 */
export function tryClaimSessionSend(sessionId: string): boolean {
  const chat = useChatStore.getState();
  if (chat.isLoadingSession(sessionId) || chat.isCompressingSession(sessionId)) {
    return false;
  }
  chat.setLoadingSession(sessionId);
  return true;
}

/** 全文下载绕过：写入固定助手回复并清 loading；返回是否已绕过 */
export function addFullTextBypassIfNeeded(opts: {
  sessionId: string;
  modelName: string;
  textContent: string;
  hasAttachments: boolean;
}): boolean {
  if (!shouldBypassModelForFullTextDownload(opts.textContent, opts.hasAttachments)) {
    return false;
  }
  const chat = useChatStore.getState();
  chat.addMessage(opts.sessionId, {
    id: `${Date.now() + 1}-a`,
    role: 'assistant',
    content: FULL_TEXT_DOWNLOAD_BYPASS_REPLY,
    timestamp: Date.now(),
    model: opts.modelName,
  });
  chat.clearLoadingForSession(opts.sessionId);
  return true;
}

export type RunModelReplyFn = (
  sessionId: string,
  priorMessages: Message[],
  userMessage: Message,
  model: ModelConfig
) => Promise<void>;

export type CommitUserMessageResult = {
  priorMessages: Message[];
  userMessage: Message;
  didCompress: boolean;
  /** 已写入全文下载绕过回复，无需再 runModelReply */
  bypassed: boolean;
};

/**
 * 桌面/远端共用：压缩门禁 → 首条标题 → 落用户消息 → 全文绕过。
 * 调用前须已 tryClaimSessionSend；中止路径由调用方 clearLoading。
 */
export async function commitUserMessageAndReply(opts: {
  sessionId: string;
  textContent: string;
  files?: FileInfo[];
  model: ModelConfig;
  locale: 'zh' | 'en';
  summaryTitle: string;
  webEnabled: boolean;
  attachmentTitle: string;
  newSessionTitle: string;
  runModelReply: RunModelReplyFn;
  /** 压缩完成后的可选 UI 钩子（如滚到底） */
  onDidCompress?: () => void;
}): Promise<CommitUserMessageResult> {
  const chat = useChatStore.getState();
  let priorMessages =
    chat.sessions.find((s) => s.id === opts.sessionId)?.messages?.slice() ?? [];

  const ensured = await ensureContextBeforeSend({
    sessionId: opts.sessionId,
    priorMessages,
    draftInput: opts.textContent,
    model: opts.model,
    locale: opts.locale,
    summaryTitle: opts.summaryTitle,
    injectExtras: resolveInjectExtras({ webEnabled: opts.webEnabled }),
  });
  priorMessages = ensured.priorMessages;
  if (ensured.didCompress) opts.onDidCompress?.();

  if (priorMessages.length === 0) {
    const titleCandidate =
      (isAttachmentPlaceholder(opts.textContent) ? opts.attachmentTitle : opts.textContent) ||
      opts.newSessionTitle;
    chat.updateSessionTitle(
      opts.sessionId,
      titleCandidate.length > 15 ? titleCandidate.substring(0, 15) + '...' : titleCandidate
    );
  }

  const files = opts.files?.length ? opts.files : undefined;
  const userMessage: Message = {
    id:
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : Date.now().toString(),
    role: 'user',
    content: opts.textContent,
    files,
    timestamp: Date.now(),
    model: opts.model.name,
  };
  chat.addMessage(opts.sessionId, userMessage);

  const bypassed = addFullTextBypassIfNeeded({
    sessionId: opts.sessionId,
    modelName: opts.model.name,
    textContent: opts.textContent,
    hasAttachments: Boolean(files?.length),
  });
  if (!bypassed) {
    await opts.runModelReply(opts.sessionId, priorMessages, userMessage, opts.model);
  }
  return {
    priorMessages,
    userMessage,
    didCompress: ensured.didCompress,
    bypassed,
  };
}
