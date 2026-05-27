import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { FiExternalLink, FiRefreshCw, FiX } from 'react-icons/fi';
import { useAgentBrowserStore } from '../store/agentBrowserStore';
import {
  notifyWebviewDomReady,
  registerAgentBrowserWebview,
} from '../agent/browser/agentBrowserController';

const AgentBrowserPanel: React.FC = () => {
  const { visible, url, title, loading, close, setPageMeta, setLoading } = useAgentBrowserStore();
  const webviewRef = useRef<Electron.WebviewTag>(null);

  /** url 一旦设定就保持 webview 在 DOM 中（可隐藏），避免 open→read 竞态 */
  const keepMounted = Boolean(url);

  useLayoutEffect(() => {
    if (!keepMounted) {
      registerAgentBrowserWebview(null);
      return;
    }
    registerAgentBrowserWebview(webviewRef.current);
    return () => registerAgentBrowserWebview(null);
  }, [keepMounted, url]);

  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv || !keepMounted) return;

    const onDomReady = () => notifyWebviewDomReady();
    const syncMeta = () => {
      try {
        setPageMeta(wv.getURL(), wv.getTitle?.() ?? '');
      } catch {
        /* 尚未 attach */
      }
    };
    const onStart = () => setLoading(true);
    const onStop = () => setLoading(false);

    wv.addEventListener('dom-ready', onDomReady);
    wv.addEventListener('did-start-loading', onStart);
    wv.addEventListener('did-stop-loading', onStop);
    wv.addEventListener('did-finish-load', syncMeta);
    wv.addEventListener('page-title-updated', syncMeta);

    return () => {
      wv.removeEventListener('dom-ready', onDomReady);
      wv.removeEventListener('did-start-loading', onStart);
      wv.removeEventListener('did-stop-loading', onStop);
      wv.removeEventListener('did-finish-load', syncMeta);
      wv.removeEventListener('page-title-updated', syncMeta);
    };
  }, [keepMounted, url, setPageMeta, setLoading]);

  if (!keepMounted) return null;

  const reload = (): void => {
    webviewRef.current?.reload();
  };

  return (
    <div
      className={
        visible
          ? 'flex shrink-0 flex-col border-t border-stone-600/30 bg-stone-100/80 dark:border-white/10 dark:bg-slate-950/70'
          : 'hidden h-0 overflow-hidden'
      }
      style={visible ? { height: 'min(42vh, 460px)' } : undefined}
    >
      {visible ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-stone-600/20 px-3 py-1.5 dark:border-white/10">
          <span className="min-w-0 flex-1 truncate text-xs text-stone-700 dark:text-slate-200">
            {loading ? '加载中…' : title || url}
          </span>
          <button
            type="button"
            onClick={reload}
            className="rounded p-1 text-stone-500 hover:bg-stone-200/80 dark:text-slate-400 dark:hover:bg-slate-800"
            title="刷新"
          >
            <FiRefreshCw size={14} />
          </button>
          <button
            type="button"
            onClick={() => {
              if (url) window.open(url, '_blank');
            }}
            className="rounded p-1 text-stone-500 hover:bg-stone-200/80 dark:text-slate-400 dark:hover:bg-slate-800"
            title="在系统浏览器打开"
          >
            <FiExternalLink size={14} />
          </button>
          <button
            type="button"
            onClick={close}
            className="rounded p-1 text-stone-500 hover:bg-stone-200/80 dark:text-slate-400 dark:hover:bg-slate-800"
            title="关闭"
          >
            <FiX size={14} />
          </button>
        </div>
      ) : null}
      <webview ref={webviewRef} src={url} className="min-h-0 flex-1 w-full" style={{ border: 'none' }} />
    </div>
  );
};

export default AgentBrowserPanel;
