import { describe, it, expect } from 'vitest';
import { StreamingDeltaSplitter, extractContentAndReasoningFromSseDataLine } from './streamChatCompletionDelta';

describe('StreamingDeltaSplitter', () => {
  it('结构化 reasoning_content 字段透传', () => {
    const s = new StreamingDeltaSplitter();
    const r1 = s.feed('data: {"choices":[{"delta":{"reasoning_content":"思考中"}}]}');
    const r2 = s.feed('data: {"choices":[{"delta":{"content":"回答"}}]}');
    s.flush();
    expect(r1.reasoning + r2.reasoning).toBe('思考中');
    expect(r1.content + r2.content).toBe('回答');
  });

  it('内联 <think> 单行完整拆分', () => {
    const s = new StreamingDeltaSplitter();
    const r = s.feed('data: {"choices":[{"delta":{"content":"<think>内部思考</think>正文"}}]}');
    s.flush();
    expect(r.content).toBe('正文');
    expect(r.reasoning).toBe('内部思考');
  });

  it('跨片 <think> 标签正确分流', () => {
    const s = new StreamingDeltaSplitter();
    const r1 = s.feed('data: {"choices":[{"delta":{"content":"<thi"}}]}');
    const r2 = s.feed('data: {"choices":[{"delta":{"content":"nk>这是思考"}}]}');
    const r3 = s.feed('data: {"choices":[{"delta":{"content":"过程</think>这是正文"}}]}');
    s.flush();
    expect(r1.content + r2.content + r3.content).toBe('这是正文');
    expect(r1.reasoning + r2.reasoning + r3.reasoning).toBe('这是思考过程');
  });

  it('未闭合 think 标签（流结束时仍思考区）', () => {
    const s = new StreamingDeltaSplitter();
    const r = s.feed('data: {"choices":[{"delta":{"content":"<think>思考内容未结束"}}]}');
    s.flush();
    expect(r.content).toBe('');
    expect(r.reasoning).toBe('思考内容未结束');
  });

  it('<thinking> 变体标签', () => {
    const s = new StreamingDeltaSplitter();
    const r = s.feed('data: {"choices":[{"delta":{"content":"<thinking>想一下</thinking>答案"}}]}');
    s.flush();
    expect(r.content).toBe('答案');
    expect(r.reasoning).toBe('想一下');
  });

  it('<think_never_used_xxx> 带后缀变体标签', () => {
    const s = new StreamingDeltaSplitter();
    const r = s.feed('data: {"choices":[{"delta":{"content":"<think_never_used_51bce0>内部推理</think_never_used_51bce0>正文回答"}}]}');
    s.flush();
    expect(r.content).toBe('正文回答');
    expect(r.reasoning).toBe('内部推理');
  });

  it('<think_xxx> 跨片带后缀标签', () => {
    const s = new StreamingDeltaSplitter();
    const r1 = s.feed('data: {"choices":[{"delta":{"content":"<think_abc>第一段"}}]}');
    const r2 = s.feed('data: {"choices":[{"delta":{"content":"推理</think_abc>最终回答"}}]}');
    s.flush();
    expect(r1.content + r2.content).toBe('最终回答');
    expect(r1.reasoning + r2.reasoning).toBe('第一段推理');
  });

  it('纯正文无标签不受影响', () => {
    const s = new StreamingDeltaSplitter();
    const r = s.feed('data: {"choices":[{"delta":{"content":"你好世界"}}]}');
    s.flush();
    expect(r.content).toBe('你好世界');
    expect(r.reasoning).toBe('');
  });

  it('reasoning_summary 字段（OpenAI o系列）', () => {
    const s = new StreamingDeltaSplitter();
    const r1 = s.feed('data: {"choices":[{"delta":{"reasoning_summary":"推理摘要"}}]}');
    const r2 = s.feed('data: {"choices":[{"delta":{"content":"最终回答"}}]}');
    s.flush();
    expect(r1.reasoning + r2.reasoning).toBe('推理摘要');
    expect(r1.content + r2.content).toBe('最终回答');
  });

  it('非 data 行返回空', () => {
    const s = new StreamingDeltaSplitter();
    const r = s.feed(': heartbeat comment');
    s.flush();
    expect(r.content).toBe('');
    expect(r.reasoning).toBe('');
  });

  it('[DONE] 返回空', () => {
    const s = new StreamingDeltaSplitter();
    const r = s.feed('data: [DONE]');
    s.flush();
    expect(r.content).toBe('');
    expect(r.reasoning).toBe('');
  });
});

describe('extractContentAndReasoningFromSseDataLine', () => {
  it('解析 reasoning_content', () => {
    const r = extractContentAndReasoningFromSseDataLine('data: {"choices":[{"delta":{"reasoning_content":"r"}}]}');
    expect(r.reasoning).toBe('r');
  });

  it('解析 content', () => {
    const r = extractContentAndReasoningFromSseDataLine('data: {"choices":[{"delta":{"content":"c"}}]}');
    expect(r.content).toBe('c');
  });
});
