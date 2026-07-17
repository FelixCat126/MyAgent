import type { Message, FileInfo, ModelConfig } from '../types';
import { useChatStore } from '../store/chatStore';
import { useModelStore } from '../store/modelStore';
import { useWebSearchStore } from '../store/webSearchStore';
import { useSettingStore } from '../store/settingStore';
import { t as tUi } from '../i18n/ui';
import { effectiveWebEnabled } from '../utils/chatModelPolicy';
import { flushZustandFilePersist } from '../utils/zustandFileStorage';
import {
  commitUserMessageAndReply,
  tryClaimSessionSend,
} from './sendPipeline';
import { resubmitEditedUserMessage } from './resubmitEditedUserMessage';

async function ensureModelsReady(): Promise<void> {
  await useModelStore.persist?.rehydrate?.();
  useModelStore.getState().initializeDefaultModels();
}

export function installRemoteChatBridge(opts: {
  runModelReply: (
    sessionId: string,
    prior: Message[],
    userMessage: Message,
    model: ModelConfig
  ) => Promise<void>;
}): () => void {
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
      const { sessions: ss, currentSessionId: cid } = chat;
      const loadingArr = Array.from(chat.loadingSessionIds);
      const compressingArr = Array.from(chat.compressingSessionIds);
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
        /** 兼容旧远端 shell：单值（集合首个）+ 数组 */
        loadingSessionId: loadingArr[0] ?? null,
        loadingSessionIds: loadingArr,
        compressingSessionId: compressingArr[0] ?? null,
        compressingSessionIds: compressingArr,
      };
    },
    getActiveModelLabel: async () => {
      await ensureModelsReady();
      return useModelStore.getState().getActiveModel()?.name ?? '';
    },
    getModelsSnapshot: async () => {
      await ensureModelsReady();
      const ms = useModelStore.getState();
      return {
        models: ms.models.map((m) => ({ id: m.id, name: m.name })),
        activeModelId: ms.activeModelId,
      };
    },
    setActiveModelId: async (modelId: string) => {
      await ensureModelsReady();
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
      await ensureModelsReady();

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

      const webOn = effectiveWebEnabled(sess, useWebSearchStore.getState().enabled);
      try {
        const result = await resubmitEditedUserMessage({
          sessionId,
          messageId,
          textContent,
          model: activeModel,
          locale: locale === 'en' ? 'en' : 'zh',
          summaryTitle: tUi(locale, 'chat.contextSummaryTitle'),
          webEnabled: webOn,
          runModelReply: opts.runModelReply,
        });
        if (!result.ok) {
          if (result.reason === 'busy') throw new Error(tUi(locale, 'remoteGateway.busySession'));
          if (result.reason === 'empty') throw new Error(tUi(locale, 'remoteGateway.emptySend'));
          if (result.reason === 'session-missing') {
            throw new Error(tUi(locale, 'remoteGateway.sessionMissing'));
          }
          if (result.reason === 'not-user') throw new Error(tUi(locale, 'remoteGateway.emptySend'));
          throw new Error(tUi(locale, 'remoteGateway.sessionMissing'));
        }
        await flushZustandFilePersist();
      } catch (e) {
        chat.clearLoadingForSession(sessionId);
        throw e;
      }
    },
    sendChat: async (payload: RemoteBridgePayload) => {
      await ensureModelsReady();
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
        await commitUserMessageAndReply({
          sessionId,
          textContent,
          files: attachments.length > 0 ? attachments : undefined,
          model: activeModel,
          locale: locale === 'en' ? 'en' : 'zh',
          summaryTitle: tUi(locale, 'chat.contextSummaryTitle'),
          webEnabled: webOn,
          attachmentTitle: tUi(locale, 'chat.attachmentTitle'),
          newSessionTitle: tUi(locale, 'session.newTitle'),
          runModelReply: opts.runModelReply,
        });
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

}
