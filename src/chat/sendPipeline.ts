import type { Message, ModelConfig } from '../types';
import { useChatStore } from '../store/chatStore';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useKnowledgeStore } from '../store/knowledgeStore';
import { FULL_TEXT_DOWNLOAD_BYPASS_REPLY } from './fullTextDownloadBypass';
import { shouldBypassModelForFullTextDownload } from '../utils/documentExportIntent';

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
