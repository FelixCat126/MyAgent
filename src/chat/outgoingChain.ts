import type { Message, WebSearchProvider, ModelConfig } from '../types';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useKnowledgeStore } from '../store/knowledgeStore';
import { getWebSearchQueryIfTriggered } from '../utils/webSearchTrigger';
import { isAttachmentPlaceholder } from '../utils/attachmentPlaceholder';
import { modelHasUsableImageGenerator } from '../store/modelStore';
import { t as tUi } from '../i18n/ui';
import type { Locale } from '../i18n/types';

function userQueryTextForRag(m: Message): string {
  const t = (m.content || '').trim();
  if (t && !isAttachmentPlaceholder(t)) return t;
  if (m.files?.length) return m.files.map((f) => f.name).join(' ');
  return '';
}


/** 本次发送是否用到工作区向量（仅用于界面提示，不落盘） */
export type VectorRagSendHint =
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
  if (!raw || isAttachmentPlaceholder(raw)) return outgoing;

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

/** 已配置生图工具时注入系统说明，否则模型（如豆包）会按常识声称「不能生图」 */
function shouldUseLocalCreativePolicy(imageGenModel: ModelConfig | undefined): boolean {
  if (!imageGenModel) return false;
  return imageGenModel.provider === 'ollama' || imageGenModel.isLocal || imageGenModel.imageGeneratorConfig?.type === 'cli';
}

export function prependImageGenCapabilitySystem(
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

export async function buildOutgoingChain(
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

export function formatVectorRagHint(
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
      detail: err.length > 120 ? err.slice(0, 120) + '…' : err,
    }),
    tone: 'error',
  };
}
