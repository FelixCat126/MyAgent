import type { Message, ModelConfig } from '../types';
import { useChatStore } from '../store/chatStore';
import { useModelStore } from '../store/modelStore';
import { useWebSearchStore } from '../store/webSearchStore';
import { useSettingStore } from '../store/settingStore';
import { effectiveWebEnabled } from '../utils/chatModelPolicy';
import { enrichMessagesForModel } from '../utils/enrichMessagesForModel';
import { sanitizeMessagesForModel } from '../utils/sanitizeMessagesForModel';
import { isAgentToolsBuildEnabled } from '@/agent/buildFlags';
import { looksLikeLocalFileAgentRequest, looksLikeLocalImageFindRequest } from '@/agent/localFileIntent';
import { looksLikeWebBrowseRequest } from '@/agent/webBrowseIntent';
import { planImageIntent } from '../utils/imageIntentPlanner';
import { inferDocumentExportHint } from '../utils/documentExportIntent';
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
  const session = useChatStore.getState().sessions.find((s) => s.id === sendSessionId);
  const webState = useWebSearchStore.getState();
  const webOn = effectiveWebEnabled(session, webState.enabled);
  ui.setVectorRagStatus(null);

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
      : prependImageGenCapabilitySystem(built.chain, ui.locale, useModelStore.getState().getEffectiveImageGenModel());
    ragHint = built.ragHint;
  } catch (e) {
    console.error(e);
    ui.addMessage(sendSessionId, {
      id: `${Date.now()}-err`,
      role: 'assistant',
      content: ui.t('chat.buildFailed') + (e instanceof Error ? e.message : String(e)),
      timestamp: Date.now(),
      model: activeModel.name,
    });
    ui.clearLoadingForSession(sendSessionId);
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
            '用户本轮明确要求可下载文档。请直接输出可作为文档保存的正文内容，使用 Markdown 标题/章节组织；不要添加“我已经为你准备好”“点击下载”“以下是文档”等聊天式前后缀，也不要把无关说明放入正文。',
          timestamp: Date.now(),
          model: 'myagent-document-export',
        },
        ...chainForModel,
      ];
    }
  } catch (e) {
    console.error(e);
    ui.addMessage(sendSessionId, {
      id: `${Date.now()}-err2`,
      role: 'assistant',
      content: ui.t('chat.buildFailed') + (e instanceof Error ? e.message : String(e)),
      timestamp: Date.now(),
      model: activeModel.name,
    });
    ui.clearLoadingForSession(sendSessionId);
    return;
  }

  ui.setVectorRagStatus(formatVectorRagHint(ragHint, ui.t));

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
