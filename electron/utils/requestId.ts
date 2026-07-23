/** 单调递增的 requestId，用于串联一次用户操作（消息发送/生图/Agent 等）的所有日志。 */
import { newId } from '../../src/utils/newId';

let current = '';

export function getRequestId(): string {
  return current;
}

export function beginRequest(seed?: string): string {
  const id = seed ?? newId();
  current = id;
  return id;
}

export function endRequest(id: string): void {
  if (current === id) current = '';
}

/** 在已存在的 requestId 下附加字段（用于 IPC 跨边界时把 renderer 的 id 透传给主进程子 logger） */
export function withRequestId<T>(id: string, fn: () => T): T {
  const prev = current;
  current = id;
  try {
    return fn();
  } finally {
    current = prev;
  }
}