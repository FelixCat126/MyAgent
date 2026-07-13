import { useAgentBrowserStore } from '../../store/agentBrowserStore';
import type { FileInfo } from '../../types';

let webviewEl: Electron.WebviewTag | null = null;
let pendingAttach: (() => void) | null = null;
let pendingDomReady: (() => void) | null = null;
/** 导航世代：仅当 readyEpoch === navEpoch 时才认为当前页已就绪 */
let navEpoch = 0;
let readyEpoch = -1;
/** 内嵌浏览器会话锁：同一时刻仅一个会话可驱动 webview；世代号防止旧任务 finally 误释放新任务 */
let browserLockSessionId: string | null = null;
let browserLockGeneration = 0;

const DEFAULT_WEBVIEW_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const WEB_EVAL_MAX_CHARS = 12_000;

export const AGENT_CANCELLED_CODE = 'AGENT_CANCELLED';

export function isAgentCancelledError(e: unknown): boolean {
  if (!e) return false;
  if (typeof e === 'object' && e !== null && 'code' in e && (e as { code?: string }).code === AGENT_CANCELLED_CODE) {
    return true;
  }
  return e instanceof Error && e.message === AGENT_CANCELLED_CODE;
}

export function createAgentCancelledError(): Error {
  const err = new Error(AGENT_CANCELLED_CODE);
  (err as Error & { code: string }).code = AGENT_CANCELLED_CODE;
  return err;
}

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

function urlsLooselyEqual(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const norm = (u: URL) => {
      u.hash = '';
      let href = u.toString();
      if (href.endsWith('/') && u.pathname !== '/') href = href.slice(0, -1);
      return href;
    };
    return norm(ua) === norm(ub);
  } catch {
    return a === b;
  }
}

async function flushReactMount(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

export function acquireAgentBrowserLock(
  sessionId: string
): { ok: true; token: number } | { ok: false; error: string } {
  const id = String(sessionId || '').trim();
  if (!id) return { ok: false, error: '会话无效，无法占用内嵌浏览器' };
  if (browserLockSessionId && browserLockSessionId !== id) {
    return {
      ok: false,
      error: '另一个会话正在使用内嵌浏览器，请等待其完成或切换回该会话后再试',
    };
  }
  browserLockSessionId = id;
  browserLockGeneration += 1;
  return { ok: true, token: browserLockGeneration };
}

export function releaseAgentBrowserLock(sessionId: string, token?: number): void {
  const id = String(sessionId || '').trim();
  if (browserLockSessionId !== id) return;
  if (token != null && token !== browserLockGeneration) return;
  browserLockSessionId = null;
}

/** Panel 仅在「当前导航世代」内上报；无进行中导航时忽略，避免污染 epoch */
export function notifyWebviewDomReady(): void {
  if (readyEpoch === navEpoch) {
    if (pendingDomReady) {
      pendingDomReady();
      pendingDomReady = null;
    }
    return;
  }
  readyEpoch = navEpoch;
  if (pendingDomReady) {
    pendingDomReady();
    pendingDomReady = null;
  }
}

export function registerAgentBrowserWebview(el: Electron.WebviewTag | null): void {
  webviewEl = el;
  if (el) {
    try {
      if (typeof el.setUserAgent === 'function') {
        el.setUserAgent(DEFAULT_WEBVIEW_UA);
      }
    } catch {
      /* 尚未 attach */
    }
  }
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

function beginNavigationEpoch(): void {
  navEpoch += 1;
  readyEpoch = -1;
  pendingDomReady = null;
}

function waitWebviewLoad(
  wv: Electron.WebviewTag,
  timeoutMs = 35000,
  shouldCancel?: () => boolean
): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      window.clearInterval(cancelPoll);
      wv.removeEventListener('did-finish-load', onLoad);
      wv.removeEventListener('did-fail-load', onFail as EventListener);
      if (err) reject(err);
      else resolve();
    };
    const onLoad = () => finish();
    const onFail = (...args: unknown[]) => {
      const maybeEvent = args[0] as
        | { errorCode?: number; errorDescription?: string; isMainFrame?: boolean }
        | undefined;
      const errorCode = Number(
        typeof args[1] === 'number' ? args[1] : maybeEvent?.errorCode ?? 0
      );
      const errorDescription = String(
        typeof args[2] === 'string' ? args[2] : maybeEvent?.errorDescription ?? ''
      );
      const isMainFrame =
        typeof args[4] === 'boolean' ? args[4] : (maybeEvent?.isMainFrame ?? true);
      if (isMainFrame === false) return;
      if (errorCode === -3) return;
      finish(new Error(`页面加载失败(${errorCode}): ${errorDescription || 'unknown error'}`));
    };
    wv.addEventListener('did-finish-load', onLoad);
    wv.addEventListener('did-fail-load', onFail as EventListener);
    const cancelPoll = window.setInterval(() => {
      if (shouldCancel?.()) finish(createAgentCancelledError());
    }, 120);
    window.setTimeout(() => finish(new Error('页面加载超时')), timeoutMs);
  });
}

function waitWebviewDomReady(
  wv: Electron.WebviewTag,
  timeoutMs = 20000,
  shouldCancel?: () => boolean
): Promise<void> {
  const expectEpoch = navEpoch;
  if (readyEpoch === expectEpoch) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      if (pendingDomReady) pendingDomReady = null;
      window.clearInterval(cancelPoll);
      if (expectEpoch !== navEpoch) {
        reject(new Error('WebView dom-ready 超时（导航已变更）'));
        return;
      }
      // load 已完成但无 dom-ready 时降级继续，避免整段 Agent 卡死
      readyEpoch = expectEpoch;
      resolve();
    }, timeoutMs);
    const cancelPoll = window.setInterval(() => {
      if (!shouldCancel?.()) return;
      window.clearTimeout(timer);
      if (pendingDomReady) pendingDomReady = null;
      window.clearInterval(cancelPoll);
      reject(createAgentCancelledError());
    }, 120);
    pendingDomReady = () => {
      window.clearTimeout(timer);
      window.clearInterval(cancelPoll);
      if (readyEpoch === expectEpoch && expectEpoch === navEpoch) resolve();
      else {
        pendingDomReady = () => {
          window.clearTimeout(timer);
          window.clearInterval(cancelPoll);
          if (readyEpoch === expectEpoch && expectEpoch === navEpoch) resolve();
        };
      }
    };
    const onDomReady = (): void => {
      wv.removeEventListener('dom-ready', onDomReady);
      notifyWebviewDomReady();
    };
    wv.addEventListener('dom-ready', onDomReady);
  });
}

async function waitForWebviewNavigation(
  wv: Electron.WebviewTag,
  shouldCancel?: () => boolean
): Promise<void> {
  await waitWebviewLoad(wv, 35000, shouldCancel);
  await waitWebviewDomReady(wv, 20000, shouldCancel);
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
      if (!/dom-ready|DOM|attached|导航不匹配/i.test(msg)) throw e;
      readyEpoch = -1;
      await new Promise((r) => window.setTimeout(r, 200 + attempt * 150));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function agentBrowserOpen(
  rawUrl: string,
  opts?: { revealPanel?: boolean; shouldCancel?: () => boolean }
): Promise<{ ok: true; url: string; title: string } | { ok: false; error: string }> {
  try {
    const normalized = normalizeUrl(rawUrl);
    if (!normalized.ok) return normalized;
    if (opts?.shouldCancel?.()) throw createAgentCancelledError();

    useAgentBrowserStore.getState().open(normalized.url, {
      visible: opts?.revealPanel !== false,
    });
    await flushReactMount();
    if (opts?.shouldCancel?.()) throw createAgentCancelledError();

    const wv = await ensureWebviewAttached();
    try {
      if (typeof wv.setUserAgent === 'function') {
        wv.setUserAgent(DEFAULT_WEBVIEW_UA);
      }
    } catch {
      /* ignore */
    }

    const current = wv.getURL?.() ?? '';
    const alreadyThere =
      Boolean(current) &&
      current !== 'about:blank' &&
      urlsLooselyEqual(current, normalized.url);

    if (!alreadyThere) {
      beginNavigationEpoch();
      wv.loadURL(normalized.url);
      await waitForWebviewNavigation(wv, opts?.shouldCancel);
    } else if (readyEpoch !== navEpoch) {
      notifyWebviewDomReady();
    }

    const url = wv.getURL();
    const title = wv.getTitle?.() ?? '';
    useAgentBrowserStore.getState().setPageMeta(url, title);
    return { ok: true, url, title };
  } catch (e) {
    useAgentBrowserStore.getState().setLoading(false);
    if (isAgentCancelledError(e)) return { ok: false, error: AGENT_CANCELLED_CODE };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 面板手动刷新时重置导航世代，避免 read/eval 误用旧 ready 态 */
export function notifyWebviewUserReload(): void {
  beginNavigationEpoch();
}

export async function agentBrowserRead(arg?: {
  maxChars?: number;
  selector?: string;
  shouldCancel?: () => boolean;
}): Promise<
  | { ok: true; url: string; title: string; text: string; matched?: boolean }
  | { ok: false; error: string }
> {
  try {
    if (arg?.shouldCancel?.()) throw createAgentCancelledError();
    const wv = webviewEl ?? (await ensureWebviewAttached());
    await waitWebviewDomReady(wv, 20000, arg?.shouldCancel);
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
    if (isAgentCancelledError(e)) return { ok: false, error: AGENT_CANCELLED_CODE };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function agentBrowserEval(arg: {
  js: string;
  shouldCancel?: () => boolean;
}): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  try {
    if (arg?.shouldCancel?.()) throw createAgentCancelledError();
    const wv = webviewEl ?? (await ensureWebviewAttached());
    const code = String(arg?.js || '').trim();
    if (!code) return { ok: false, error: 'js 为空' };
    if (code.length > WEB_EVAL_MAX_CHARS) {
      return { ok: false, error: `web_eval 脚本过长（上限 ${WEB_EVAL_MAX_CHARS} 字符）` };
    }
    await waitWebviewDomReady(wv, 20000, arg?.shouldCancel);
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
    if (isAgentCancelledError(e)) return { ok: false, error: AGENT_CANCELLED_CODE };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function agentBrowserClose(): Promise<{ ok: true; closed: boolean }> {
  useAgentBrowserStore.getState().close();
  webviewEl = null;
  navEpoch = 0;
  readyEpoch = -1;
  pendingDomReady = null;
  return { ok: true, closed: true };
}

export async function agentBrowserExtractFirstImage(opts?: {
  shouldCancel?: () => boolean;
}): Promise<
  { ok: true; url: string; pageUrl: string; title: string } | { ok: false; error: string }
> {
  if (opts?.shouldCancel?.()) return { ok: false, error: AGENT_CANCELLED_CODE };
  const js = `
    (async () => {
      const pick = (img) => {
        const u =
          img.getAttribute('data-imgurl') ||
          img.getAttribute('data-objurl') ||
          img.getAttribute('data-thumburl') ||
          img.getAttribute('data-src') ||
          img.getAttribute('src') ||
          '';
        if (!/^https?:/i.test(u)) return null;
        if (/logo|icon|loading|spacer|blank\\.gif|fbdpic|favicon|gstatic\\.com\\/images\\/branding/i.test(u)) return null;
        return u;
      };
      for (let attempt = 0; attempt < 5; attempt++) {
        window.scrollTo(0, 200 + attempt * 180);
        await new Promise((r) => setTimeout(r, 700 + attempt * 350));
        const sels = [
          '.imgitem img', 'img.main_img', 'img[data-imgurl]', '.general-img img', '.imgbox img', '.imgpage img',
          '#imgid img', '.imglist img',
          'div[data-id] img', 'a[href*=\"imgurl\"] img', '#search img', 'img.rg_i', 'g-img img'
        ];
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
  const r = await agentBrowserEval({ js, shouldCancel: opts?.shouldCancel });
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

/** 优先页内 fetch（带 Cookie），失败再主进程带 Referer 拉取，落盘为本地附件 */
export async function materializeWebImageAttachment(arg: {
  imageUrl: string;
  pageUrl?: string;
  fileName?: string;
  shouldCancel?: () => boolean;
}): Promise<{ ok: true; file: FileInfo } | { ok: false; error: string }> {
  const imageUrl = String(arg.imageUrl || '').trim();
  if (!/^https?:\/\//i.test(imageUrl)) {
    return { ok: false, error: '无效图片 URL' };
  }
  if (arg.shouldCancel?.()) return { ok: false, error: AGENT_CANCELLED_CODE };
  const referer = String(arg.pageUrl || '').trim();
  const fileName = arg.fileName || 'web-image';

  try {
    const escapedUrl = JSON.stringify(imageUrl);
    const pageFetch = await agentBrowserEval({
      shouldCancel: arg.shouldCancel,
      js: `
        const res = await fetch(${escapedUrl}, { credentials: 'include', mode: 'cors', cache: 'force-cache' });
        if (!res.ok) return { __fail: 'HTTP ' + res.status };
        const blob = await res.blob();
        const contentType = blob.type || res.headers.get('content-type') || 'image/jpeg';
        const buf = await blob.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
        }
        return { contentType, base64: btoa(bin) };
      `,
    });
    if (pageFetch.ok && pageFetch.result && typeof pageFetch.result === 'object') {
      const r = pageFetch.result as { base64?: string; contentType?: string; __fail?: string };
      if (r.base64 && !r.__fail) {
        const saved = await window.electron.agentWebSaveRemoteImage({
          base64: `data:${r.contentType || 'image/jpeg'};base64,${r.base64}`,
          contentType: r.contentType,
          fileName,
          referer,
          url: imageUrl,
        });
        if (saved.ok && saved.path) {
          return {
            ok: true,
            file: {
              name: saved.name || `${fileName}.jpg`,
              path: saved.path,
              type: saved.type || 'image/jpeg',
              size: saved.size || 0,
              preview: saved.preview,
            },
          };
        }
      }
    }
  } catch {
    /* 页内失败则走主进程 */
  }

  if (arg.shouldCancel?.()) return { ok: false, error: AGENT_CANCELLED_CODE };

  const saved = await window.electron.agentWebSaveRemoteImage({
    url: imageUrl,
    referer: referer || undefined,
    fileName,
  });
  if (!saved.ok || !saved.path) {
    return { ok: false, error: saved.error || '保存远程图片失败' };
  }
  if (arg.shouldCancel?.()) return { ok: false, error: AGENT_CANCELLED_CODE };
  return {
    ok: true,
    file: {
      name: saved.name || `${fileName}.jpg`,
      path: saved.path,
      type: saved.type || 'image/jpeg',
      size: saved.size || 0,
      preview: saved.preview,
    },
  };
}

export const BAIDU_FIRST_IMAGE_EXTRACT_SIG = 'web_eval:baidu-first-image-extract';
