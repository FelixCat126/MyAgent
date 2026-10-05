import { StringDecoder } from 'node:string_decoder';

export type SseReadableStream = {
  on: (event: string, listener: (arg?: unknown) => void) => unknown;
  destroy?: () => void;
};

/**
 * 兼容服务的 SSE 完成信号。部分网关发出终止事件后仍保持 HTTP keep-alive，
 * 因此不能只等待 Node readable 的物理 end。
 */
export function isTerminalSseLine(line: string): boolean {
  const trimmed = line.trim();
  if (/^event:\s*(message_stop|response\.completed|done)\s*$/i.test(trimmed)) return true;
  if (!trimmed.startsWith('data:')) return false;
  const raw = trimmed.slice(5).trim();
  if (raw === '[DONE]') return true;
  if (!raw) return false;
  try {
    const data = JSON.parse(raw) as {
      type?: string;
      done?: boolean;
      status?: string;
      choices?: Array<{ finish_reason?: unknown }>;
    };
    if (data.type === 'message_stop' || data.type === 'response.completed') return true;
    if (data.done === true || data.status === 'completed') return true;
    return Boolean(data.choices?.some((choice) => choice.finish_reason != null));
  } catch {
    return false;
  }
}

/** 按行消费 SSE；遇到协议完成信号便主动结束本地读取，不再等远端关闭 keep-alive。 */
export function consumeSseLines(
  stream: SseReadableStream,
  onLine: (line: string) => void,
  options: { firstEventTimeoutMs?: number; maxDurationMs?: number } = {}
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    let settled = false;
    const durationTimer = options.maxDurationMs ? setTimeout(() => {
      if (settled) return;
      settled = true;
      if (firstEventTimer) clearTimeout(firstEventTimer);
      reject(new Error('MODEL_STREAM_DURATION_TIMEOUT'));
      stream.destroy?.();
    }, options.maxDurationMs) : null;
    const firstEventTimer = options.firstEventTimeoutMs
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          if (durationTimer) clearTimeout(durationTimer);
          const error = new Error('MODEL_STREAM_FIRST_EVENT_TIMEOUT') as Error & { code?: string };
          error.code = 'ETIMEDOUT';
          reject(error);
          stream.destroy?.();
        }, options.firstEventTimeoutMs)
      : null;

    const settle = (destroy = false) => {
      if (settled) return;
      settled = true;
      if (durationTimer) clearTimeout(durationTimer);
      if (firstEventTimer) clearTimeout(firstEventTimer);
      resolve();
      if (destroy) stream.destroy?.();
    };

    const consumeLine = (line: string): boolean => {
      try {
        onLine(line);
      } catch (error) {
        settled = true;
        if (durationTimer) clearTimeout(durationTimer);
        if (firstEventTimer) clearTimeout(firstEventTimer);
        reject(error);
        stream.destroy?.();
        return true;
      }
      if (!isTerminalSseLine(line)) return false;
      settle(true);
      return true;
    };

    stream.on('data', (value?: unknown) => {
      if (settled) return;
      if (firstEventTimer) clearTimeout(firstEventTimer);
      buffer += Buffer.isBuffer(value) ? decoder.write(value) : String(value ?? '');
      const parts = buffer.split('\n');
      buffer = parts.pop() || '';
      for (const line of parts) {
        if (consumeLine(line.replace(/\r$/, ''))) break;
      }
    });
    stream.on('end', () => {
      if (settled) return;
      buffer += decoder.end();
      if (buffer) {
        for (const line of buffer.split('\n')) {
          if (consumeLine(line.replace(/\r$/, ''))) return;
        }
      }
      settle();
    });
    stream.on('error', (value?: unknown) => {
      if (settled) return;
      settled = true;
      if (durationTimer) clearTimeout(durationTimer);
      if (firstEventTimer) clearTimeout(firstEventTimer);
      reject(value instanceof Error ? value : new Error(String(value ?? 'SSE stream error')));
    });
  });
}
