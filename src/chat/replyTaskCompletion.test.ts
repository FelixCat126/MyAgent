import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '../store/chatStore';
import { useModelStore } from '../store/modelStore';
import { useSettingStore } from '../store/settingStore';
import { bindSessionTask } from '../features/runtime/taskBridge';
import { runSyncReplyPath, type RunSyncReplyPathArgs } from './runSyncReplyPath';
import { runStreamReplyPath } from './runStreamReplyPath';
import { runAgentReplyPath } from './runAgentReplyPath';
import { runAgentLoop } from '../agent/agentRunner';
import { runImagePostProcess } from './runModelReplyShared';
import { t } from '../i18n/ui';
import type { RunModelReplyUi } from './runModelReplyTypes';
import type { ModelConfig, Message } from '../types';
import type { RuntimeTask } from '../features/runtime/api';

vi.mock('../agent/agentRunner', () => ({ runAgentLoop: vi.fn() }));

const model: ModelConfig = { id: 'reply-model', name: 'Reply model', provider: 'openai', apiUrl: 'https://fixture.example/v1', modelName: 'fixture', isLocal: false, maxTokens: 4096 };
const imageModel: ModelConfig = { ...model, id: 'image-model', isImageGenerator: true, imageGeneratorConfig: { type: 'http', endpoint: 'https://fixture.example/images' } };
const tool = JSON.stringify({ myagent_tool: 'generate_image', prompt: 'A blue watercolor cat', count: 1 });
const image = { path: '/fixture/cat.png', url: 'file:///fixture/cat.png', width: 1024, height: 1024, size: 120 };

function fixture(userText = 'Hello'): RunSyncReplyPathArgs {
  const chat = useChatStore.getState();
  const sid = chat.createSession(null);
  const user: Message = { id: `${sid}-user`, role: 'user', content: userText, timestamp: Date.now(), model: model.name };
  chat.addMessage(sid, user);
  chat.setLoadingSession(sid);
  const task: RuntimeTask = { id: `${sid}-task`, title: userText, kind: 'agent', status: 'running', steps: [], createdAt: Date.now(), updatedAt: Date.now(), checkpoint: { userMessageId: user.id } };
  bindSessionTask(sid, task);
  const ui: RunModelReplyUi = {
    locale: 'zh', t: key => t('zh', key), consumeVoiceWakeReply: () => false,
    setVoiceReplySpeaking: vi.fn(), setVectorRagStatus: vi.fn(), setImageGenProgress: vi.fn(), setIsStreaming: vi.fn(), setStreamingTargetAssistantId: vi.fn(),
    setInlineImageIndex: vi.fn(), inlineImageIndexRef: { current: 0 }, streamingAssistantIdRef: { current: null }, streamingSessionIdRef: { current: null }, streamUnsubRef: { current: null }, streamHadErrorRef: { current: false }, streamCancelledByUserRef: { current: false }, imageGenCancelledRef: { current: false }, imageGenSyncRef: { current: null }, speechReaderRef: { current: null },
    addMessage: chat.addMessage, updateMessage: chat.updateMessage, appendToMessage: chat.appendToMessage, appendReasoningToMessage: chat.appendReasoningToMessage, removeMessage: chat.removeMessage, clearLoadingForSession: chat.clearLoadingForSession,
  };
  return { ui, sendSessionId: sid, userMessage: user, historyBeforeUser: [], activeModel: model, plainMessages: [user], plainModel: model, exportHint: undefined };
}

async function respond(args: RunSyncReplyPathArgs, mode: 'sync' | 'stream', content: string, reasoning = ''): Promise<void> {
  if (mode === 'sync') {
    vi.spyOn(window.electron, 'callModel').mockResolvedValue({ content, reasoning });
    const work = runSyncReplyPath(args);
    await vi.runAllTimersAsync();
    await work;
  } else {
    let handlers!: Parameters<typeof window.electron.subscribeModelStream>[2];
    vi.spyOn(window.electron, 'subscribeModelStream').mockImplementation((_messages, _model, callbacks) => { handlers = callbacks; return () => {}; });
    expect(runStreamReplyPath(args)).toBe(true);
    if (reasoning) handlers.onThinkingDelta?.(reasoning);
    if (content) handlers.onDelta(content);
    handlers.onEnd();
    await vi.runAllTimersAsync();
  }
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.restoreAllMocks();
  useChatStore.setState({ sessions: [], currentSessionId: null, activeLeafId: null, loadingSessionIds: new Set(), compressingSessionIds: new Set() });
  useModelStore.setState({ models: [model, imageModel], activeModelId: model.id, imageGenModelId: imageModel.id });
  useSettingStore.setState({ streamResponses: true, locale: 'zh' });
  vi.spyOn(window.electron, 'runtimeCompleteTask').mockImplementation(async input => ({ id: input.id, title: '', kind: 'agent', status: input.error ? 'failed' : 'completed', steps: [], createdAt: 1, updatedAt: 1, result: input.result, error: input.error }));
});
afterEach(async () => { await vi.runAllTimersAsync(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe.each(['sync', 'stream'] as const)('%s reply completion follows execution outcome', mode => {
  it.each(['', '   '])('marks a successful provider response with no body (%j) as failed', async body => {
    const args = fixture();
    await respond(args, mode, body);
    expect(window.electron.runtimeCompleteTask).toHaveBeenCalledWith(expect.objectContaining({ error: '模型返回空回答', result: expect.objectContaining({ content: t('zh', 'chat.fallbackReply') }) }));
    expect(useChatStore.getState().isLoadingSession(args.sendSessionId)).toBe(false);
  });
  it('marks reasoning-only completion as failed while preserving its readable hint', async () => {
    await respond(fixture(), mode, '', '思考');
    expect(window.electron.runtimeCompleteTask).toHaveBeenCalledWith(expect.objectContaining({ error: '模型返回空回答', result: expect.objectContaining({ content: t('zh', 'chat.emptyAfterReasoning') }) }));
  });
  it('records failed image generation as failed while preserving other metadata', async () => {
    const args = fixture('生成一张图片');
    const update = args.ui.updateMessage;
    args.ui.updateMessage = (sid, id, patch) => { update(sid, id, patch); };
    const add = args.ui.addMessage;
    args.ui.addMessage = (sid, message) => { add(sid, { ...message, meta: { runtimeTaskId: 'keep-me' } }); };
    vi.spyOn(window.electron, 'generateImage').mockRejectedValue(new Error('connection refused'));
    await respond(args, mode, tool);
    expect(window.electron.runtimeCompleteTask).toHaveBeenCalledWith(expect.objectContaining({ error: 'connection refused' }));
    const answer = useChatStore.getState().sessions[0].messages.at(-1)!;
    expect(answer.content).toContain('图片生成失败');
    expect(answer.meta).toEqual({ runtimeTaskId: 'keep-me', taskError: 'connection refused' });
  });
  it('completes a reply with valid image files and no prose', async () => {
    vi.spyOn(window.electron, 'generateImage').mockResolvedValue([image]);
    await respond(fixture('生成一张图片'), mode, tool);
    expect(window.electron.runtimeCompleteTask).toHaveBeenCalledWith(expect.objectContaining({ error: undefined, result: expect.objectContaining({ content: '', files: [expect.objectContaining({ path: image.path })] }) }));
  });
  it('retains partial image files on a failed task', async () => {
    const args = fixture('生成三张图片');
    vi.spyOn(window.electron, 'generateImage').mockImplementation(async (_input, handlers) => { handlers?.onImage?.({ requestId: 'fixture', image, index: 1, total: 3 }); throw new Error('second image failed'); });
    await respond(args, mode, tool);
    expect(window.electron.runtimeCompleteTask).toHaveBeenCalledWith(expect.objectContaining({ error: 'second image failed', result: expect.objectContaining({ content: expect.stringContaining('1/3'), files: [expect.objectContaining({ path: image.path })] }) }));
  });
});

describe('data-tool artifact completion', () => {
  it('plays a verified Agent answer promptly while preserving gradual output', async () => {
    useSettingStore.setState({ agentLocalToolsEnabled: true });
    const args = fixture('分析附件数据');
    args.userMessage.files = [{ name: 'sales.csv', path: '/fixture/sales.csv', type: 'text/csv', size: 31 }];
    const answer = '结果'.repeat(60);
    vi.mocked(runAgentLoop).mockResolvedValue({ handled: true, displayText: answer });
    const chunks: string[] = [];
    const append = args.ui.appendToMessage;
    args.ui.appendToMessage = (sessionId, messageId, chunk) => {
      chunks.push(chunk);
      append(sessionId, messageId, chunk);
    };

    const work = runAgentReplyPath({ ...args, chainForModel: [args.userMessage], isLocalImageFind: false, isWebBrowseTask: false });
    await vi.advanceTimersByTimeAsync(1500);
    await expect(work).resolves.toBe(true);
    expect(chunks.join('')).toBe(answer);
    expect(chunks.length).toBeGreaterThan(20);
    expect(Math.max(...chunks.map(chunk => Array.from(chunk).length))).toBeLessThanOrEqual(2);
  });

  it('stops a verified Agent answer replay without revealing the unread remainder', async () => {
    useSettingStore.setState({ agentLocalToolsEnabled: true });
    const args = fixture('分析附件数据');
    args.userMessage.files = [{ name: 'sales.csv', path: '/fixture/sales.csv', type: 'text/csv', size: 31 }];
    const answer = '结果'.repeat(100);
    vi.mocked(runAgentLoop).mockResolvedValue({ handled: true, displayText: answer });

    const work = runAgentReplyPath({ ...args, chainForModel: [args.userMessage], isLocalImageFind: false, isWebBrowseTask: false });
    await vi.advanceTimersByTimeAsync(50);
    args.ui.streamCancelledByUserRef.current = true;
    await vi.advanceTimersByTimeAsync(100);
    await expect(work).resolves.toBe(true);
    const partial = useChatStore.getState().sessions.find(session => session.id === args.sendSessionId)?.messages.at(-1)?.content ?? '';
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(answer.length);
    await vi.advanceTimersByTimeAsync(1000);
    expect(useChatStore.getState().sessions.find(session => session.id === args.sendSessionId)?.messages.at(-1)?.content).toBe(partial);
  });

  it('does not turn a negated additional image request into the completed-chart fallback', async () => {
    const args = fixture('汇总生成柱状图，不要再生成猫咪图片');
    const answer = '汇总和柱状图已完成。';
    args.ui.addMessage(args.sendSessionId, { id: 'negated-mixed-answer', role: 'assistant', content: answer, timestamp: Date.now(), model: model.name });
    const generate = vi.spyOn(window.electron, 'generateImage');
    const result = await runImagePostProcess({ ...args, assistantId: 'negated-mixed-answer', rawText: answer, generatedFiles: [{ name: 'chart.svg', path: '/fixture/DataResults/chart.svg', type: 'image/svg+xml', size: 1435 }] });
    expect(result.plannedIntent.shouldGenerate).toBe(false);
    expect(result.content).toBe(answer);
    expect(generate).not.toHaveBeenCalled();
    args.ui.clearLoadingForSession(args.sendSessionId);
    await Promise.resolve();
  });
  it('generates the explicitly requested creative image after a completed chart even when the model returned only the data answer', async () => {
    const args = fixture('汇总生成柱状图，再生成猫咪图片');
    const answer = '汇总和柱状图已完成。';
    const assistant: Message = { id: 'mixed-answer', role: 'assistant', content: answer, timestamp: Date.now(), model: model.name };
    args.ui.addMessage(args.sendSessionId, assistant);
    const chart = { name: 'chart.svg', path: '/fixture/DataResults/chart.svg', type: 'image/svg+xml', size: 1435 };
    const generate = vi.spyOn(window.electron, 'generateImage').mockResolvedValue([image]);
    const work = runImagePostProcess({ ...args, assistantId: assistant.id, rawText: answer, generatedFiles: [chart] });
    await vi.runAllTimersAsync();
    const result = await work;
    expect(result.plannedIntent.shouldGenerate).toBe(true);
    expect(generate).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ prompt: '再生成猫咪图片', count: 1 }), expect.anything());
    expect(result.content.trim()).toBe(answer);
    expect(result.files).toEqual([expect.objectContaining({ path: image.path })]);
    expect(result.taskError).toBeUndefined();
    args.ui.updateMessage(args.sendSessionId, assistant.id, { content: result.content, files: [chart, ...result.files!] });
    args.ui.clearLoadingForSession(args.sendSessionId);
    await Promise.resolve();
    expect(window.electron.runtimeCompleteTask).toHaveBeenCalledWith(expect.objectContaining({ error: undefined }));
  });
  it.each([
    '按 category 计算 amount 合计，生成汇总表和柱状图。',
    '按 category 汇总，把这张图重新生成得清楚些。',
  ])('preserves a completed data answer and its files without requiring image service: %s', async prompt => {
    useModelStore.setState({ models: [model], imageGenModelId: null });
    useSettingStore.setState({ agentLocalToolsEnabled: true });
    const args = fixture(prompt);
    args.userMessage.files = [{ name: 'sales.csv', path: '/fixture/sales.csv', type: 'text/csv', size: 31 }];
    const files = [
      { name: 'result.xlsx', path: '/fixture/DataResults/result.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 7476 },
      { name: 'chart.svg', path: '/fixture/DataResults/chart.svg', type: 'image/svg+xml', size: 1435 },
    ];
    const answer = '已完成汇总：A 类 amount 合计 30，B 类合计 7。汇总表和柱状图见下方文件。';
    vi.mocked(runAgentLoop).mockResolvedValue({ handled: true, displayText: answer, exportFiles: files });
    const generate = vi.spyOn(window.electron, 'generateImage');
    const work = runAgentReplyPath({ ...args, chainForModel: [args.userMessage], isLocalImageFind: false, isWebBrowseTask: false });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(work).resolves.toBe(true);
    expect(generate).not.toHaveBeenCalled();
    expect(window.electron.runtimeCompleteTask).toHaveBeenCalledWith(expect.objectContaining({ error: undefined, result: expect.objectContaining({ content: answer, files }) }));
  });
});
