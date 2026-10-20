import { describe, expect, it, vi } from 'vitest';
import { cancelVideoForSession, planAssistantVideoIntent, repairInterruptedVideoMessages, runVideoPostProcess } from './videoGenAssist';
import { useChatStore } from '../store/chatStore';
import type { Message, ModelConfig } from '../types';
import type { RunModelReplyUi } from './runModelReplyTypes';
describe('video generation intent', () => {
 it('uses the user brief rather than assistant explanation, and supports English requests', () => {
  expect(planAssistantVideoIntent('生成一段小猫奔跑的视频，不要背景音乐', '抱歉，我不能创建视频', false)).toEqual({ shouldGenerate: true, prompt: '生成一段小猫奔跑的视频，不要背景音乐' });
  expect(planAssistantVideoIntent('Create a short video of a blue bird flying', 'I can help.', false).shouldGenerate).toBe(true);
  for (const text of ['生成小猫视频', '来一段赛车视频', '把这段文字做成视频', '帮我做一个产品宣传短片', '做个 10 秒的短视频，内容是猫跳舞']) expect(planAssistantVideoIntent(text, '', false).shouldGenerate, text).toBe(true);
 });
 it('does not submit paid jobs for analysis, tutorials, prompt writing, negation or existing output', () => {
  for (const text of ['帮我分析这个视频', '如何生成视频？', '生成视频的提示词怎么写？', '不要生成视频', 'Can you generate video?', 'Write a prompt for generating a video']) expect(planAssistantVideoIntent(text, 'response', false).shouldGenerate, text).toBe(false);
  expect(planAssistantVideoIntent('生成小猫视频', 'done', true).shouldGenerate).toBe(false);
 });
 it('does not treat recorded, watched or discussed videos as generation requests', () => {
  for (const text of ['帮我总结我录的这段视频说了什么', '我出差时看到一个视频，讲的是什么意思', '把我拍的视频转成文字', '帮我做个视频剪辑的学习计划', '我昨天做了一个视频，帮我取个标题', '出来玩的视频里有谁']) expect(planAssistantVideoIntent(text, '', false).shouldGenerate, text).toBe(false);
 });
});
describe('video wait cancellation and restart recovery', () => {
 const user: Message = { id: 'user-1', role: 'user', content: '生成一段小猫奔跑的视频', timestamp: 1 };
 const model = { id: 'video-1', name: 'video', isVideoGenerator: true, videoGeneratorConfig: { provider: 'minimax', model: 'MiniMax-Hailuo-02', apiKey: 'fixture' } } as unknown as ModelConfig;
 it('stops writing results back after the session is cancelled and asks the main process to stop waiting', async () => {
  let finish: (value: unknown) => void = () => {};
  const generateVideo = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const cancelVideo = vi.fn(async () => ({ ok: true, canceled: true }));
  Object.assign(window.electron, { generateVideo, cancelVideo });
  const updateMessage = vi.fn();
  const pending = runVideoPostProcess({ ui: { updateMessage } as unknown as RunModelReplyUi, sendSessionId: 'session-cancel', assistantId: 'assistant-cancel', rawText: '好的', userMessage: user, activeModel: model, historyBeforeUser: [], videoModel: model });
  await vi.waitFor(() => expect(generateVideo).toHaveBeenCalled());
  cancelVideoForSession('session-cancel');
  expect(cancelVideo).toHaveBeenCalledWith('vid-assistant-cancel');
  finish({ ok: true, localPath: '/tmp/video.mp4' });
  const result = await pending;
  expect(result.files).toBeUndefined();
  expect(updateMessage.mock.calls.some(([, , patch]) => (patch as Message).files)).toBe(false);
  expect(String(updateMessage.mock.calls.at(-1)?.[2]?.content)).toContain('已停止视频生成等待');
 });
 it('rewrites a stale generating marker left by a previous process', () => {
  const sessionId = useChatStore.getState().createSession();
  const assistant: Message = { id: 'assistant-stale', role: 'assistant', content: '好的\n\n_🎬 视频生成中：PROCESSING_', timestamp: 2 };
  useChatStore.setState(state => ({ sessions: state.sessions.map(s => s.id === sessionId ? { ...s, messages: [assistant] } : s) }));
  expect(repairInterruptedVideoMessages()).toBe(1);
  const content = useChatStore.getState().sessions.find(s => s.id === sessionId)!.messages[0].content;
  expect(content).not.toContain('视频生成中'); expect(content).toContain('视频生成已中断');
 });
});
