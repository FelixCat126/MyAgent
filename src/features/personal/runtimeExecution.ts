import type { RuntimeTask } from '../runtime/api';
import { bindSessionTask, saveSessionCheckpoint, sessionTask } from '../runtime/taskBridge';
import { useChatStore } from '../../store/chatStore';
import { useModelStore } from '../../store/modelStore';
import { useSettingStore } from '../../store/settingStore';
import { useWebSearchStore } from '../../store/webSearchStore';
import { getActiveMessages } from '../../utils/branchTree';
import { effectiveWebEnabled } from '../../utils/chatModelPolicy';
import { resolveSendModel } from '../../agent/resolveSendModel';
import { commitUserMessageAndReply, tryClaimSessionSend, type RunModelReplyFn } from '../../chat/sendPipeline';
import { t as translate } from '../../i18n/ui';
import { waitForSessionTaskEnd, runtimeTaskWasCancelled } from './runtimeDispatcher';

/** Execute background/retried tasks through the same chat path, preserving the original user turn on retry. */
export async function executeDispatchedRuntimeTask(task: RuntimeTask, runModelReply: RunModelReplyFn): Promise<void> {
  const chat = useChatStore.getState();
  const locale = useSettingStore.getState().locale;
  const checkpointId = typeof task.checkpoint?.sessionId === 'string' ? task.checkpoint.sessionId : undefined;
  let session = chat.sessions.find((entry) => entry.id === checkpointId);
  if (!session) {
    const current = chat.sessions.find((entry) => entry.id === chat.currentSessionId);
    if (!checkpointId && current && !current.messages.length) session = current;
    else {
      const previous = chat.currentSessionId;
      const sid = chat.createSession();
      session = useChatStore.getState().sessions.find((entry) => entry.id === sid);
      if (previous) chat.switchSession(previous);
    }
  }
  if (!session) throw new Error('Task conversation could not be created');
  const sourceId = typeof task.checkpoint?.userMessageId === 'string' ? task.checkpoint.userMessageId : undefined;
  const source = session.messages.find((message) => message.id === sourceId && message.role === 'user');
  const prompt = source?.content ?? task.prompt ?? '';
  if (!prompt.trim() && !source?.files?.length) throw new Error(locale === 'en' ? 'The task has no instructions.' : '任务没有执行内容。');
  const models = useModelStore.getState();
  const preferred = models.models.find((model) => model.id === task.checkpoint?.modelId || model.name === task.checkpoint?.modelId);
  const active = preferred ?? models.getActiveModel();
  if (!active) throw new Error(translate(locale, 'chat.configureModel'));
  const history = source ? getActiveMessages(session.messages, source.id).filter((message) => message.id !== source.id) : getActiveMessages(session.messages, session.activeLeafId);
  const model = resolveSendModel({ models: models.models, activeModel: active, routingRules: models.routingRules, history, userText: prompt, hasImages: Boolean(source?.files?.some((file) => file.type.startsWith('image/'))) });
  if (!model) throw new Error(translate(locale, 'chat.configureModel'));
  if (!tryClaimSessionSend(session.id)) throw new Error(translate(locale, 'chat.anotherConversationBusy'));
  bindSessionTask(session.id, task);
  try {
    await saveSessionCheckpoint(session.id, { sessionId: session.id, foreground: false, modelId: model.id });
    if (runtimeTaskWasCancelled(task.id) || sessionTask(session.id)?.id !== task.id) return;
    if (source) {
      // Keep partial old results on their branch; never duplicate the user's message.
      chat.forkFromMessage(session.id, source.id);
      await runModelReply(session.id, history, source, model);
    } else {
      await commitUserMessageAndReply({
        sessionId: session.id, textContent: prompt, model, locale,
        summaryTitle: translate(locale, 'chat.contextSummaryTitle'),
        webEnabled: effectiveWebEnabled(session, useWebSearchStore.getState().enabled),
        attachmentTitle: translate(locale, 'chat.attachmentTitle'), newSessionTitle: translate(locale, 'session.newTitle'),
        runModelReply: async (sid, prior, user, selected) => {
          await saveSessionCheckpoint(sid, { userMessageId: user.id, modelId: selected.id });
          if (runtimeTaskWasCancelled(task.id) || sessionTask(sid)?.id !== task.id) return;
          await runModelReply(sid, prior, user, selected);
        },
      });
    }
    await waitForSessionTaskEnd(session.id);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const latest = useChatStore.getState().sessions.find((entry) => entry.id === session!.id);
    if (latest && latest.messages[latest.messages.length - 1]?.meta?.taskError !== detail) chat.addMessage(session.id, { id: crypto.randomUUID(), role: 'assistant', content: detail, meta: { taskError: detail }, model: model.name, timestamp: Date.now() });
    chat.clearLoadingForSession(session.id);
    throw error;
  }
}
