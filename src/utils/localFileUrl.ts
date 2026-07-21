/**
 * 渲染进程替代 Node url.pathToFileURL 的最小实现（渲染层不应 import Node 内置模块）。
 * 段级 encodeURIComponent 保斜杠；fileURLToPath 侧会按百分号解码，与之往返兼容。
 */
export function pathToFileUrlHref(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, '/');
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `file://${withSlash
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')}`;
}

/** 应用内 local-file:// 协议地址（主进程 protocol.handle 配套，含路径白名单） */
export function localFileProtocolUrl(absolutePath: string): string {
  return pathToFileUrlHref(absolutePath).replace(/^file:/i, 'local-file:');
}
