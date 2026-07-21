/** 会话/消息 id 生成：优先 crypto.randomUUID，降级 时间戳+随机串（非安全上下文兜底） */
export function newId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
