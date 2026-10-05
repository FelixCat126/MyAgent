import { describe, expect, it } from 'vitest';
import { planAssistantVideoIntent } from './videoGenAssist';
describe('video generation intent', () => {
 it('uses the user brief rather than assistant explanation, and supports English requests', () => {
  expect(planAssistantVideoIntent('生成一段小猫奔跑的视频，不要背景音乐', '抱歉，我不能创建视频', false)).toEqual({ shouldGenerate: true, prompt: '生成一段小猫奔跑的视频，不要背景音乐' });
  expect(planAssistantVideoIntent('Create a short video of a blue bird flying', 'I can help.', false).shouldGenerate).toBe(true);
 });
 it('does not submit paid jobs for analysis, tutorials, prompt writing, negation or existing output', () => {
  for (const text of ['帮我分析这个视频', '如何生成视频？', '生成视频的提示词怎么写？', '不要生成视频', 'Can you generate video?', 'Write a prompt for generating a video']) expect(planAssistantVideoIntent(text, 'response', false).shouldGenerate, text).toBe(false);
  expect(planAssistantVideoIntent('生成小猫视频', 'done', true).shouldGenerate).toBe(false);
 });
});
