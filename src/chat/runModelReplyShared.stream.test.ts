import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnimStream } from './runModelReplyShared';

describe('createAnimStream', () => {
  it('取消播放丢弃未显示增量并结束等待，不在停止后继续打字', async () => {
    vi.useFakeTimers();
    const append=vi.fn();const stream=createAnimStream('s','a',append);
    stream.push('这是一段待显示文字');const finish=stream.finish();
    await vi.advanceTimersByTimeAsync(20);stream.cancel();await finish;
    stream.push('迟到增量');await vi.advanceTimersByTimeAsync(1000);
    expect(append.mock.calls.map(call=>call[2]).join('')).toBe('这');
    expect(vi.getTimerCount()).toBe(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('小缓冲以稳定阅读节拍推进，并在结束前自然排空', async () => {
    vi.useFakeTimers();
    const append = vi.fn();
    const stream = createAnimStream('session', 'assistant', append);

    stream.push('Mini');
    stream.push('Max');
    expect(append).not.toHaveBeenCalled();
    const finished = stream.finish();

    await vi.advanceTimersByTimeAsync(19);
    expect(append).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(append).toHaveBeenLastCalledWith('session', 'assistant', 'M');
    expect(append).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();
    await finished;

    expect(append.mock.calls.map((call) => call[2]).join('')).toBe('MiniMax');
  });

  it('正式回答稳定在每秒约 50 个中文视觉单位，不随模型瞬时返回速度暴涨', async () => {
    vi.useFakeTimers();
    let rendered = '';
    const stream = createAnimStream('s', 'a', (_sessionId, _assistantId, chunk) => {
      rendered += chunk;
    });
    stream.push('汉'.repeat(100));

    await vi.advanceTimersByTimeAsync(1000);
    expect(rendered.length).toBeGreaterThanOrEqual(49);
    expect(rendered.length).toBeLessThanOrEqual(51);
    await vi.advanceTimersByTimeAsync(1000);
    expect(rendered).toHaveLength(100);
  });

  it('积压很大时也严格限制单次增量，不再出现上百字跳跃', async () => {
    vi.useFakeTimers();
    const append = vi.fn();
    const stream = createAnimStream('s', 'a', append);
    stream.push('汉'.repeat(1000));

    await vi.advanceTimersByTimeAsync(120);

    const chunks = append.mock.calls.map((call) => String(call[2] ?? ''));
    expect(chunks.length).toBe(6);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBe(1);
  });

  it('中文标点不再强制停顿，正文持续以约 50 字每秒推进', async () => {
    vi.useFakeTimers();
    const append = vi.fn();
    const stream = createAnimStream('s', 'a', append);
    stream.push('你好，世界');

    await vi.advanceTimersByTimeAsync(60);
    expect(append.mock.calls.map((call) => call[2]).join('')).toBe('你好，');
    await vi.advanceTimersByTimeAsync(20);
    expect(append.mock.calls.map((call) => call[2]).join('')).toBe('你好，世');
    await vi.advanceTimersByTimeAsync(20);
    expect(append.mock.calls.map((call) => call[2]).join('')).toBe('你好，世界');
  });

  it('渲染回调耗时不会逐字叠加到显示间隔', async () => {
    vi.useFakeTimers();
    const shownAt: number[] = [];
    const stream = createAnimStream('s', 'a', () => {
      shownAt.push(performance.now());
      vi.advanceTimersByTime(12);
    });
    stream.push('连续输出文字');

    await vi.advanceTimersByTimeAsync(120);

    expect(shownAt.slice(0, 5)).toEqual([20, 40, 60, 80, 100]);
  });

  it('偶发长帧会温和追赶，单次最多补两个中文字符', async () => {
    vi.useFakeTimers();
    const chunks: string[] = [];
    const stream = createAnimStream('s', 'a', (_sessionId, _assistantId, chunk) => {
      chunks.push(chunk);
      if (chunks.length === 1) vi.advanceTimersByTime(100);
    });
    stream.push('汉'.repeat(20));
    const finished = stream.finish();

    await vi.runAllTimersAsync();
    await finished;

    expect(chunks.join('')).toBe('汉'.repeat(20));
    expect(chunks[0]).toBe('汉');
    expect(chunks.some((chunk) => chunk.length === 2)).toBe(true);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBe(2);
  });

  it('不会把 emoji 的代理对拆成两个残缺字符', async () => {
    vi.useFakeTimers();
    const append = vi.fn();
    const stream = createAnimStream('s', 'a', append);
    stream.push('🙂好');

    await vi.advanceTimersByTimeAsync(20);
    expect(append).toHaveBeenCalledWith('s', 'a', '🙂');
  });

  it('思考过程以约 100 字每秒逐字显示，不把模型增量整块塞入界面', async () => {
    vi.useFakeTimers();
    const append = vi.fn();
    const stream = createAnimStream('s', 'a', append, { pace: 'reasoning' });

    stream.push('快速思考');

    expect(append).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9);
    expect(append).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(append).toHaveBeenLastCalledWith('s', 'a', '快');
    await vi.advanceTimersByTimeAsync(30);
    expect(append.mock.calls.map((call) => call[2])).toEqual(['快', '速', '思', '考']);
    await expect(stream.finish()).resolves.toBeUndefined();
  });

  it('已完成的 Agent 答案加快回放，同时保留逐字打字感', async () => {
    vi.useFakeTimers();
    const chunks: string[] = [];
    const stream = createAnimStream('s', 'a', (_sessionId, _assistantId, chunk) => {
      chunks.push(chunk);
    }, { pace: 'completed' });
    stream.push('汉'.repeat(100));
    const finished = stream.finish();

    await vi.advanceTimersByTimeAsync(500);
    expect(chunks.join('')).toHaveLength(50);
    expect(chunks.every((chunk) => chunk.length === 1)).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    await finished;
    expect(chunks.join('')).toHaveLength(100);
  });

  it('暂停的正文会等待思考逐字排空，恢复后才开始输出', async () => {
    vi.useFakeTimers();
    const reasoningAppend = vi.fn();
    const contentAppend = vi.fn();
    const reasoning = createAnimStream('s', 'a', reasoningAppend, { pace: 'reasoning' });
    const content = createAnimStream('s', 'a', contentAppend, { startPaused: true });

    reasoning.push('思考中');
    content.push('正式回答');
    const startContent = reasoning.finish().then(() => content.resume());

    await vi.advanceTimersByTimeAsync(29);
    expect(reasoningAppend.mock.calls.map((call) => call[2]).join('')).toBe('思考');
    expect(contentAppend).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await startContent;
    expect(reasoningAppend.mock.calls.map((call) => call[2]).join('')).toBe('思考中');
    expect(contentAppend).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20);
    expect(contentAppend).toHaveBeenCalledWith('s', 'a', '正');
  });

  it('中断或报错时仍可立即写完等待中的增量', () => {
    vi.useFakeTimers();
    const append = vi.fn();
    const stream = createAnimStream('s', 'a', append);

    stream.push('完整结尾');
    stream.flush();

    expect(append).toHaveBeenCalledWith('s', 'a', '完整结尾');
    expect(vi.getTimerCount()).toBe(0);
  });
});
