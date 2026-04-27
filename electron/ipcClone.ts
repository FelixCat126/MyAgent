/**
 * Electron IPC（invoke / send）使用 Structured Clone，Proxy、函数等会报
 * “An object could not be cloned”。经 JSON 往返得到可传输的纯数据。
 */
export function cloneForIpc<T>(value: T): T {
  try {
    const s = JSON.stringify(value);
    if (s === undefined) return undefined as T;
    return JSON.parse(s) as T;
  } catch (e) {
    console.error('[cloneForIpc]', e);
    throw new Error('无法序列化以供 IPC 传输（请避免在消息中带函数或循环引用）');
  }
}
