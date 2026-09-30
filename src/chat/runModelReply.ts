import { fulfillDocumentArtifact, resolveOrCreateAssistantBubble } from './runModelReplyShared';
import { beginReplyRun, replyRunWasCancelled } from './imageTaskState';
import type { Message, ModelConfig } from '../types';
import { useChatStore } from '../store/chatStore';
import { useModelStore } from '../store/modelStore';
import { useWebSearchStore } from '../store/webSearchStore';
import { effectiveWebEnabled } from '../utils/chatModelPolicy';
import { enrichMessagesForModel } from '../utils/enrichMessagesForModel';
import { sanitizeMessagesForModel } from '../utils/sanitizeMessagesForModel';
import { looksLikeLocalImageFindRequest } from '@/agent/localFileIntent';
import { looksLikeWebBrowseRequest } from '@/agent/webBrowseIntent';
import { shouldEnterAgentReply } from '@/agent/shouldEnterAgentReply';
import { inferDocumentExportHint, previousDocumentBody, unsupportedDocumentRequest } from '../utils/documentExportIntent';
import {
  buildOutgoingChain,
  formatVectorRagHint,
  prependImageGenCapabilitySystem,
  type VectorRagSendHint,
} from './outgoingChain';
import { runAgentReplyPath } from './runAgentReplyPath';
import { runStreamReplyPath } from './runStreamReplyPath';
import { runSyncReplyPath } from './runSyncReplyPath';
import type { RunModelReplyUi } from './runModelReplyTypes';

export type { RunModelReplyUi } from './runModelReplyTypes';

export async function runModelReply(
  ui: RunModelReplyUi,
  sendSessionId: string,
  historyBeforeUser: Message[],
  userMessage: Message,
  activeModel: ModelConfig
): Promise<void> {
  beginReplyRun(sendSessionId, userMessage.id);
  ui.imageGenCancelledRef.current = false;
  ui.streamCancelledByUserRef.current = false;
  const session = useChatStore.getState().sessions.find((s) => s.id === sendSessionId);
  const webState = useWebSearchStore.getState();
  const webOn = effectiveWebEnabled(session, webState.enabled);
  ui.setVectorRagStatus(null);

  let chain: Message[];
  let ragHint: VectorRagSendHint;
  const exportHint = inferDocumentExportHint(userMessage.content);
  if (unsupportedDocumentRequest(userMessage.content)) {
    ui.addMessage(sendSessionId, { id: `${Date.now()}-unsupported-format`, role: 'assistant', content: ui.t('document.unsupported'), timestamp: Date.now(), model: activeModel.name });
    ui.clearLoadingForSession(sendSessionId);
    return;
  }
  const previousBody = previousDocumentBody(userMessage.content, historyBeforeUser);
  if (exportHint && previousBody && !userMessage.files?.length) {
    const assistantId = resolveOrCreateAssistantBubble(ui, sendSessionId, `${Date.now()}-convert`, { modelName: activeModel.name, exportHint: { ...exportHint, status: 'generating' } });
    try { await fulfillDocumentArtifact({ ui, sendSessionId, assistantId, shouldCancel: () => replyRunWasCancelled(sendSessionId, userMessage.id), rawText: previousBody, userText: userMessage.content, exportHint }); }
    finally { ui.clearLoadingForSession(sendSessionId); }
    return;
  }
  const isLocalImageFind = looksLikeLocalImageFindRequest(userMessage.content);
  const isWebBrowseTask = looksLikeWebBrowseRequest(userMessage.content);
  const agentGate = shouldEnterAgentReply({
    userText: userMessage.content,
    exportDocument: Boolean(exportHint?.document),
  });
  /** 本机/网页 Agent 任务均跳过向量注入，避免无关 RAG 干扰工具链 */
  const skipContextInject = agentGate.enter;
  /** 链路构建失败的统一收尾：插入错误气泡 + 清 loading（id 后缀区分两个阶段） */
  const failWith = (idSuffix: string, e: unknown): void => {
    if (replyRunWasCancelled(sendSessionId, userMessage.id)) return;
    console.error(e);
    ui.addMessage(sendSessionId, {
      id: `${Date.now()}-${idSuffix}`,
      role: 'assistant',
      content: ui.t('chat.buildFailed') + (e instanceof Error ? e.message : String(e)),
      timestamp: Date.now(),
      model: activeModel.name,
    });
    ui.clearLoadingForSession(sendSessionId);
  };
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
      : prependImageGenCapabilitySystem(built.chain, ui.locale, useModelStore.getState().getEffectiveImageGenModel());
    ragHint = built.ragHint;
  } catch (e) {
    failWith('err', e);
    return;
  }

  let chainForModel: Message[];
  try {
    chainForModel = await enrichMessagesForModel(chain, ui.locale);
    if (exportHint?.document) {
      chainForModel = [
        {
          id: `doc-export-sys-${Date.now()}`,
          role: 'system',
          content:
            `用户要求生成 ${exportHint.formats?.join('、')} 文件。应用负责创建真实附件，你只需输出完整 Markdown 正文，不能伪造下载链接或声称文件已经生成。使用明确的标题、简洁的章节、规范列表和表格，不要把全文包进代码围栏。Excel/CSV 必须输出有列名的 Markdown 管道表格，CSV 只能有一张表；不要用代码代替表格。保留用户要求的数据、单位和文件名，不要编造事实。仅要求转换格式时必须完整保留原文，不得总结、删节或另写一篇。不要添加聊天式前后缀。`,
          timestamp: Date.now(),
          model: 'myagent-document-export',
        },
        ...chainForModel,
      ];
    }
  } catch (e) {
    failWith('err2', e);
    return;
  }

  if (replyRunWasCancelled(sendSessionId, userMessage.id)) return;
  ui.setVectorRagStatus(formatVectorRagHint(ragHint, ui.t));

  const plainMessages = JSON.parse(JSON.stringify(sanitizeMessagesForModel(chainForModel))) as Message[];
  const plainModel = JSON.parse(JSON.stringify(activeModel)) as ModelConfig;

  if (
    await runAgentReplyPath({
      ui,
      sendSessionId,
      historyBeforeUser,
      userMessage,
      activeModel,
      chainForModel,
      exportHint,
      isLocalImageFind,
      isWebBrowseTask,
    })
  ) {
    return;
  }

  if (
    runStreamReplyPath({
      ui,
      sendSessionId,
      historyBeforeUser,
      userMessage,
      activeModel,
      plainMessages,
      plainModel,
      exportHint,
    })
  ) {
    return;
  }

  await runSyncReplyPath({
    ui,
    sendSessionId,
    historyBeforeUser,
    userMessage,
    activeModel,
    plainMessages,
    plainModel,
    exportHint,
  });
}
