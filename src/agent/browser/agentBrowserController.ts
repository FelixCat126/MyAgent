import { useAgentBrowserStore } from '../../store/agentBrowserStore';

let webviewEl: Electron.WebviewTag | null = null;
let pendingAttach: (() => void) | null = null;
let pendingDomReady: (() => void) | null = null;
let domReadyForNav = false;

function normalizeUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const input = String(raw || '').trim();
  if (!input) return { ok: false, error: 'URL 为空' };
  try {
    const url = new URL(/^https?:\/\//i.test(input) || /^file:\/\//i.test(input) ? input : `https://${input}`);
    if (!/^https?:$|^file:$/i.test(url.protocol)) {
      return { ok: false, error: `不允许的协议：${url.protocol}` };
    }
    return { ok: true, url: url.toString() };
  } catch {
    return { ok: false, error: `无效 URL：${input}` };
  }
}

/** 等待 React 挂载内嵌 webview（store.open 后下一帧才能拿到 ref） */
async function flushReactMount(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

export function notifyWebviewDomReady(): void {
  domReadyForNav = true;
  if (pendingDomReady) {
    pendingDomReady();
    pendingDomReady = null;
  }
}

export function registerAgentBrowserWebview(el: Electron.WebviewTag | null): void {
  webviewEl = el;
  if (el && pendingAttach) {
    pendingAttach();
    pendingAttach = null;
  }
}

async function ensureWebviewAttached(timeoutMs = 12000): Promise<Electron.WebviewTag> {
  if (webviewEl) return webviewEl;
  await new Promise<void>((resolve, reject) => {
    pendingAttach = resolve;
    window.setTimeout(() => {
      if (pendingAttach === resolve) {
        pendingAttach = null;
        reject(new Error('内嵌浏览器未就绪，请确认已开启「对话内嵌浏览」'));
      }
    }, timeoutMs);
  });
  if (!webviewEl) throw new Error('内嵌浏览器未就绪');
  return webviewEl;
}

function waitWebviewDomReady(wv: Electron.WebviewTag, timeoutMs = 20000): Promise<void> {
  if (domReadyForNav) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      if (pendingDomReady) pendingDomReady = null;
      reject(new Error('WebView dom-ready 超时'));
    }, timeoutMs);
    pendingDomReady = () => {
      window.clearTimeout(timer);
      resolve();
    };
    const onDomReady = (): void => {
      wv.removeEventListener('dom-ready', onDomReady);
      notifyWebviewDomReady();
    };
    wv.addEventListener('dom-ready', onDomReady);
  });
}

function waitWebviewLoad(wv: Electron.WebviewTag, timeoutMs = 35000): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      wv.removeEventListener('did-finish-load', onLoad);
      wv.removeEventListener('did-fail-load', onFail);
      resolve();
    };
    const onLoad = () => finish();
    const onFail = () => finish();
    wv.addEventListener('did-finish-load', onLoad);
    wv.addEventListener('did-fail-load', onFail);
    window.setTimeout(finish, timeoutMs);
  });
}

async function waitForWebviewNavigation(wv: Electron.WebviewTag): Promise<void> {
  domReadyForNav = false;
  await waitWebviewLoad(wv);
  await waitWebviewDomReady(wv);
}

async function executeInWebview<T>(wv: Electron.WebviewTag, js: string, userGesture = true): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await waitWebviewDomReady(wv);
      return (await wv.executeJavaScript(js, userGesture)) as T;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!/dom-ready|DOM|attached/i.test(msg)) throw e;
      domReadyForNav = false;
      await new Promise((r) => window.setTimeout(r, 200 + attempt * 150));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function agentBrowserOpen(
  rawUrl: string,
  opts?: { revealPanel?: boolean }
): Promise<{ ok: true; url: string; title: string } | { ok: false; error: string }> {
  try {
    const normalized = normalizeUrl(rawUrl);
    if (!normalized.ok) return normalized;

    useAgentBrowserStore.getState().open(normalized.url, {
      visible: opts?.revealPanel !== false,
    });
    await flushReactMount();

    const wv = await ensureWebviewAttached();
    const current = wv.getURL?.() ?? '';
    if (!current || current === 'about:blank' || current !== normalized.url) {
      domReadyForNav = false;
      wv.loadURL(normalized.url);
    }
    await waitForWebviewNavigation(wv);

    const url = wv.getURL();
    const title = wv.getTitle?.() ?? '';
    useAgentBrowserStore.getState().setPageMeta(url, title);
    return { ok: true, url, title };
  } catch (e) {
    useAgentBrowserStore.getState().setLoading(false);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function agentBrowserRead(arg?: {
  maxChars?: number;
  selector?: string;
}): Promise<
  | { ok: true; url: string; title: string; text: string; matched?: boolean }
  | { ok: false; error: string }
> {
  try {
    const wv = webviewEl ?? (await ensureWebviewAttached());
    await waitWebviewDomReady(wv);
    const maxChars = Math.max(200, Math.min(20000, Number(arg?.maxChars) || 4000));
    const selector = typeof arg?.selector === 'string' ? arg.selector : '';
    const escaped = selector.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    const js = `
      (() => {
        const out = { url: location.href, title: document.title };
        const sel = \`${escaped}\`;
        if (sel) {
          const el = document.querySelector(sel);
          out.matched = !!el;
          out.text = el ? (el.innerText || el.textContent || '').slice(0, ${maxChars}) : '';
        } else {
          out.text = (document.body && (document.body.innerText || document.body.textContent) || '').slice(0, ${maxChars});
        }
        return out;
      })();
    `;
    const result = await executeInWebview<{
      url: string;
      title: string;
      text: string;
      matched?: boolean;
    }>(wv, js, true);
    useAgentBrowserStore.getState().setPageMeta(result.url, result.title);
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function agentBrowserEval(arg: {
  js: string;
}): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  try {
    const wv = webviewEl ?? (await ensureWebviewAttached());
    const code = String(arg?.js || '').trim();
    if (!code) return { ok: false, error: 'js 为空' };
    const wrapped = `(async () => { try { ${code} } catch (e) { return { __agent_web_error__: String(e && e.message || e) }; } })()`;
    const result = await Promise.race([
      executeInWebview(wv, wrapped, true),
      new Promise((_, reject) => window.setTimeout(() => reject(new Error('eval timeout 30s')), 30000)),
    ]);
    if (result && typeof result === 'object' && '__agent_web_error__' in (result as Record<string, unknown>)) {
      return { ok: false, error: String((result as Record<string, unknown>).__agent_web_error__) };
    }
    let serialized: unknown = result;
    try {
      JSON.stringify(serialized);
    } catch {
      serialized = String(result);
    }
    return { ok: true, result: serialized };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function agentBrowserClose(): Promise<{ ok: true; closed: boolean }> {
  useAgentBrowserStore.getState().close();
  webviewEl = null;
  domReadyForNav = false;
  return { ok: true, closed: true };
}

/** 百度图片搜索结果页：滚动并等待懒加载后取第一张可用图 URL */
export async function agentBrowserExtractFirstImage(): Promise<
  { ok: true; url: string; pageUrl: string; title: string } | { ok: false; error: string }
> {
  const js = `
    (async () => {
      const pick = (img) => {
        const u =
          img.getAttribute('data-imgurl') ||
          img.getAttribute('data-objurl') ||
          img.getAttribute('data-thumburl') ||
          img.getAttribute('src') ||
          '';
        if (!/^https?:/i.test(u)) return null;
        if (/logo|icon|loading|spacer|blank\\.gif|fbdpic|favicon/i.test(u)) return null;
        return u;
      };
      for (let attempt = 0; attempt < 5; attempt++) {
        window.scrollTo(0, 200 + attempt * 180);
        await new Promise((r) => setTimeout(r, 700 + attempt * 350));
        const sels = ['.imgitem img', 'img.main_img', 'img[data-imgurl]', '.general-img img', '.imgbox img', '.imgpage img'];
        for (const sel of sels) {
          for (const img of document.querySelectorAll(sel)) {
            const u = pick(img);
            if (u) return { url: u, pageUrl: location.href, title: document.title };
          }
        }
        for (const img of document.querySelectorAll('img')) {
          if ((img.naturalWidth || img.width || 0) < 48) continue;
          const u = pick(img);
          if (u) return { url: u, pageUrl: location.href, title: document.title };
        }
      }
      return null;
    })()
  `;
  const r = await agentBrowserEval({ js });
  if (!r.ok) return r;
  const result = r.result as { url?: string; pageUrl?: string; title?: string } | null;
  if (!result?.url) {
    return { ok: false, error: '页面中未找到可提取的图片 URL（可能仍在加载或被站点限制）' };
  }
  return {
    ok: true,
    url: result.url,
    pageUrl: result.pageUrl || '',
    title: result.title || '',
  };
}

export const BAIDU_FIRST_IMAGE_EXTRACT_SIG = 'web_eval:baidu-first-image-extract';
