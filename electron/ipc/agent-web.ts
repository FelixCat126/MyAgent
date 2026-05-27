import { ipcMain, type WebContents } from 'electron';

/**
 * Agent 内嵌浏览器 IPC 桥：主进程仅转发到渲染进程的内嵌 webview 控制器。
 * 实际逻辑在 src/agent/browser/agentBrowserController.ts（由 ChatWindow 注册 window 桥）。
 */

async function invokeRendererBrowser<T>(wc: WebContents, method: string, arg?: unknown): Promise<T> {
  const payload = arg === undefined ? 'undefined' : JSON.stringify(arg);
  return wc.executeJavaScript(
    `(async () => {
      const bridge = window.__MYAGENT_AGENT_BROWSER__;
      if (!bridge || typeof bridge.${method} !== 'function') {
        throw new Error('内嵌浏览器未初始化');
      }
      return await bridge.${method}(${payload});
    })()`
  ) as Promise<T>;
}

ipcMain.handle('agent-web-open', async (event, arg: { url?: string }) => {
  try {
    return await invokeRendererBrowser(event.sender, 'open', arg?.url ?? '');
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle('agent-web-read', async (event, arg?: { maxChars?: number; selector?: string }) => {
  try {
    return await invokeRendererBrowser(event.sender, 'read', arg ?? null);
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle('agent-web-eval', async (event, arg: { js?: string }) => {
  try {
    return await invokeRendererBrowser(event.sender, 'eval', arg ?? null);
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle('agent-web-close', async (event) => {
  try {
    return await invokeRendererBrowser(event.sender, 'close', null);
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
});

console.log('✅ Agent 内嵌浏览器 IPC 已注册');
