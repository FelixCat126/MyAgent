import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { consumeSseLines, isTerminalSseLine } from './sseStreamCompletion';

class FakeStream extends EventEmitter {
  destroy = vi.fn();
}

describe('SSE stream completion', () => {
  it('保留在网络分块边界拆开的中文和 emoji', async () => {
    const stream = new FakeStream();
    const lines: string[] = [];
    const completed = consumeSseLines(stream, line => lines.push(line));
    const bytes = Buffer.from('data: {"text":"中文🙂"}\n');
    for (const byte of bytes) stream.emit('data', Buffer.from([byte]));
    stream.emit('end');
    await completed;
    expect(lines).toEqual(['data: {"text":"中文🙂"}']);
  });

  it('解析器抛错会拒绝请求并关闭连接，不留下悬空运行态', async () => {
    const stream = new FakeStream();
    const completed = consumeSseLines(stream, () => { throw new Error('bad tool JSON'); });
    const rejected = expect(completed).rejects.toThrow('bad tool JSON');
    expect(() => stream.emit('data', 'data: {}\n')).not.toThrow();
    await rejected;
    expect(stream.destroy).toHaveBeenCalledOnce();
  });
  it('识别 OpenAI、GLM、MiMo 与 Anthropic 常见完成信号', () => {
    expect(isTerminalSseLine('data: [DONE]')).toBe(true);
    expect(isTerminalSseLine('data: {"choices":[{"finish_reason":"stop"}]}')).toBe(true);
    expect(isTerminalSseLine('data: {"type":"message_stop"}')).toBe(true);
    expect(isTerminalSseLine('event: response.completed')).toBe(true);
    expect(isTerminalSseLine('data: {"choices":[{"finish_reason":null}]}')).toBe(false);
  });

  it('服务发出 DONE 但不关闭连接时也会结束，并主动释放本地流', async () => {
    const stream = new FakeStream();
    const lines: string[] = [];
    const completed = consumeSseLines(stream, (line) => lines.push(line));

    stream.emit('data', Buffer.from('data: {"choices":[{"delta":{"content":"OK"}}]}\n'));
    stream.emit('data', Buffer.from('data: [DO'));
    stream.emit('data', Buffer.from('NE]\n'));

    await expect(completed).resolves.toBeUndefined();
    expect(lines.at(-1)).toBe('data: [DONE]');
    expect(stream.destroy).toHaveBeenCalledOnce();
  });

  it('没有协议完成信号时仍兼容普通 end', async () => {
    const stream = new FakeStream();
    const completed = consumeSseLines(stream, () => undefined);
    stream.emit('data', 'data: {"choices":[{"delta":{"content":"OK"}}]}');
    stream.emit('end');
    await expect(completed).resolves.toBeUndefined();
    expect(stream.destroy).not.toHaveBeenCalled();
  });

  it('建立连接后迟迟没有首个事件会超时，不再无限运行', async () => {
    vi.useFakeTimers();
    const stream = new FakeStream();
    const completed = consumeSseLines(stream, () => undefined, { firstEventTimeoutMs: 30_000 });
    const assertion = expect(completed).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(stream.destroy).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
