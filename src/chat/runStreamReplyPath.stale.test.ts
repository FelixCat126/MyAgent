/** 回归：停止后旧轮次的打字机积压立即丢弃，且旧 onEnd 不得改写同会话新一轮的 ref / 界面态 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatStore } from '../store/chatStore';
import { useSettingStore } from '../store/settingStore';
import { beginReplyRun, cancelReplyRun } from './imageTaskState';
import { runStreamReplyPath } from './runStreamReplyPath';
import { t } from '../i18n/ui';
import type { RunModelReplyUi } from './runModelReplyTypes';
import type { Message, ModelConfig } from '../types';

const model: ModelConfig = { id: 'm', name: 'M', provider: 'openai', apiUrl: 'https://fixture.example/v1', modelName: 'fixture', isLocal: false, maxTokens: 4096 };

beforeEach(() => {
  vi.useFakeTimers();
  useChatStore.setState({ sessions: [], currentSessionId: null, activeLeafId: null, loadingSessionIds: new Set(), compressingSessionIds: new Set() });
  useSettingStore.setState({ streamResponses: true, locale: 'zh' });
});
afterEach(async () => { await vi.runAllTimersAsync(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('停止排空中的旧回复：正文不再继续输出，新一轮的 ref 不被清掉', async () => {
  const chat = useChatStore.getState();
  const sid = chat.createSession(null);
  const user: Message = { id: 'u1', role: 'user', content: '写一篇长文', timestamp: 1, model: model.name };
  chat.addMessage(sid, user);
  chat.setLoadingSession(sid);
  const setIsStreaming = vi.fn();
  const ui: RunModelReplyUi = {
    locale: 'zh', t: (key) => t('zh', key), consumeVoiceWakeReply: () => false,
    setVoiceReplySpeaking: vi.fn(), setVectorRagStatus: vi.fn(), setImageGenProgress: vi.fn(), setIsStreaming, setStreamingTargetAssistantId: vi.fn(),
    setInlineImageIndex: vi.fn(), inlineImageIndexRef: { current: 0 }, streamingAssistantIdRef: { current: null }, streamingSessionIdRef: { current: null },
    streamUnsubRef: { current: null }, streamHadErrorRef: { current: false }, streamCancelledByUserRef: { current: false }, cancelAnimRef: { current: null },
    imageGenCancelledRef: { current: false }, imageGenSyncRef: { current: null }, speechReaderRef: { current: null },
    addMessage: chat.addMessage, updateMessage: chat.updateMessage, appendToMessage: chat.appendToMessage, appendReasoningToMessage: chat.appendReasoningToMessage, removeMessage: chat.removeMessage, clearLoadingForSession: chat.clearLoadingForSession,
  };
  let handlers!: Parameters<typeof window.electron.subscribeModelStream>[2];
  vi.spyOn(window.electron, 'subscribeModelStream').mockImplementation((_m, _c, callbacks) => { handlers = callbacks; return () => {}; });

  const runId = beginReplyRun(sid, user.id);
  expect(runStreamReplyPath({ ui, sendSessionId: sid, historyBeforeUser: [], userMessage: user, activeModel: model, plainMessages: [user], plainModel: model, exportHint: undefined, runId })).toBe(true);
  const answer = '长'.repeat(500);
  handlers.onDelta(answer);
  handlers.onEnd();
  await vi.advanceTimersByTimeAsync(200);
  const assistantId = ui.streamingAssistantIdRef.current!;
  const shownAtStop = useChatStore.getState().sessions[0].messages.find((m) => m.id === assistantId)!.content.length;
  expect(shownAtStop).toBeGreaterThan(0);
  expect(shownAtStop).toBeLessThan(answer.length);

  /** 与 ChatWindow.stopSessionWork 一致的停止动作 */
  cancelReplyRun(sid);
  ui.cancelAnimRef!.current?.();
  ui.streamCancelledByUserRef.current = true;
  chat.clearLoadingForSession(sid);
  /** 同会话立即开始下一轮（重新生成复用同一用户消息 id） */
  beginReplyRun(sid, user.id);
  const nextUnsub = () => {};
  ui.streamCancelledByUserRef.current = false;
  ui.streamUnsubRef.current = nextUnsub;
  ui.streamingSessionIdRef.current = sid;
  setIsStreaming.mockClear();

  await vi.runAllTimersAsync();
  const final = useChatStore.getState().sessions[0].messages.find((m) => m.id === assistantId)!.content;
  expect(final.startsWith('长'.repeat(shownAtStop))).toBe(true);
  expect(final.replace(/\s+/g, '').length).toBeLessThan(answer.length);
  expect(final).toContain(t('zh', 'chat.stoppedBanner'));
  expect(ui.streamUnsubRef.current).toBe(nextUnsub);
  expect(ui.streamingSessionIdRef.current).toBe(sid);
  expect(setIsStreaming).not.toHaveBeenCalledWith(false);
});
