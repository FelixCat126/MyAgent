/**
 * 渲染进程替代 Node url.pathToFileURL 的最小实现（渲染层不应 import Node 内置模块）。
 * 段级 encodeURIComponent 保斜杠；Windows 盘符前缀 [A-Za-z]: 不被分段编码。
 * fileURLToPath 侧会按百分号解码，与之往返兼容。
 */
function encodePathSegment(seg: string): string {
  if (!seg) return seg;
  try {
    /** 已百分号编码的段先解码再编码一次，避免 %20 → %2520 */
    return encodeURIComponent(decodeURIComponent(seg));
  } catch {
    return encodeURIComponent(seg);
  }
}

export function pathToFileUrlHref(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, '/');
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  const parts = withSlash.split('/').map((seg, i) => {
    /**
     * Windows 盘符：`/C:/...` 分段后盘符在 index=1（index=0 为空串）；
     * 无前导斜杠时也可能落在 index=0。
     */
    if ((i === 0 || i === 1) && /^[A-Za-z]:$/.test(seg)) return seg;
    return encodePathSegment(seg);
  });
  return `file://${parts.join('/')}`;
}

/** 应用内 local-file:// 协议地址（主进程 protocol.handle 配套，含路径白名单） */
export function localFileProtocolUrl(absolutePath: string): string {
  return pathToFileUrlHref(absolutePath).replace(/^file:/i, 'local-file:');
}
