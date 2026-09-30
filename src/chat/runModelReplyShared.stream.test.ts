import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnimStream } from './runModelReplyShared';

describe('createAnimStream', () => {
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
    stream.push('x'.repeat(1000));

    await vi.advanceTimersByTimeAsync(120);

    const chunks = append.mock.calls.map((call) => String(call[2] ?? ''));
    expect(chunks.length).toBe(6);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBe(1);
  });

  it('中文标点后有轻微停顿，形成自然阅读节奏', async () => {
    vi.useFakeTimers();
    const append = vi.fn();
    const stream = createAnimStream('s', 'a', append);
    stream.push('你好，世界');

    await vi.advanceTimersByTimeAsync(60);
    expect(append.mock.calls.map((call) => call[2]).join('')).toBe('你好，');
    await vi.advanceTimersByTimeAsync(43);
    expect(append.mock.calls.map((call) => call[2]).join('')).toBe('你好，');
    await vi.advanceTimersByTimeAsync(1);
    expect(append.mock.calls.map((call) => call[2]).join('')).toBe('你好，世');
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
