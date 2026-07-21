/** 生图链路诊断日志；仅 MYAGENT_DEBUG=1 时输出，避免生产环境刷屏/泄露用户 prompt */
export function imgGenDebug(...args: unknown[]): void {
  if (process.env.MYAGENT_DEBUG) console.warn(...args);
}
