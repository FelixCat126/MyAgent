import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { pathToFileURL } from 'url';
import { FiImage, FiX } from 'react-icons/fi';
import { ChatSession } from '../types';
import { useI18n } from '../hooks/useI18n';
import { ConversationImageGalleryModal } from './MessageItem';
import {
  type ConversationImageGalleryItem,
  conversationGallerySlidesFromPaths,
} from '@/utils/conversationImageGallery';

const TRANSITION_MS = 320;

function collectImageAttachmentPathsFromSessions(sessions: ChatSession[]): string[] {
  const set = new Set<string>();
  for (const s of sessions) {
    for (const m of s.messages ?? []) {
      for (const f of m.files ?? []) {
        if (!f?.type?.startsWith('image/')) continue;
        const p = (f.path ?? '').trim();
        if (p) set.add(p);
      }
    }
  }
  return [...set];
}

type Props = {
  open: boolean;
  /** 会话内仍挂载过的图片路径（与磁盘扫描合并，含已从列表删除的对话所遗留文件仍会出现在扫描结果中） */
  sessions: ChatSession[];
  onClose: () => void;
};

const ImageLibraryDrawer: React.FC<Props> = ({ open, sessions, onClose }) => {
  const { t } = useI18n();
  const [mounted, setMounted] = useState(false);
  const [entered, setEntered] = useState(false);

  /** 退场动画完成后卸载 */
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  useEffect(() => {
    if (!mounted) return;
    if (!open) {
      setEntered(false);
      const tid = window.setTimeout(() => setMounted(false), TRANSITION_MS);
      return () => clearTimeout(tid);
    }
    const rid = window.requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(rid);
  }, [open, mounted]);

  const extraPaths = useMemo(() => collectImageAttachmentPathsFromSessions(sessions), [sessions]);

  const [paths, setPaths] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [previewSlides, setPreviewSlides] = useState<ConversationImageGalleryItem[] | null>(null);
  const [previewStart, setPreviewStart] = useState(0);
  const [previewNonce, setPreviewNonce] = useState(0);

  useEffect(() => {
    if (!entered || previewSlides !== null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [entered, previewSlides, onClose]);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadErr(null);
    try {
      const r = await window.electron.listMediaLibraryImages({
        extraPaths,
      });
      if (!r.ok) setLoadErr(r.error || 'unknown');
      else setPaths((r.items ?? []).map((x) => x.absolutePath));
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [extraPaths]);

  useEffect(() => {
    if (mounted && entered) void reload();
  }, [mounted, entered, reload]);

  const thumbs = paths;

  const openPreviewAt = useCallback((index: number) => {
    if (!paths.length || index < 0 || index >= paths.length) return;
    setPreviewSlides(conversationGallerySlidesFromPaths(paths));
    setPreviewStart(index);
    setPreviewNonce((n) => n + 1);
  }, [paths]);

  if (!mounted) return null;

  return (
    <>
      <div
        className="pointer-events-none absolute inset-0 z-[55] overflow-hidden"
        aria-hidden={!entered}
      >
        <button
          type="button"
          className={`pointer-events-auto absolute inset-0 bg-black/45 transition-opacity duration-300 ease-out ${
            entered ? 'opacity-100' : 'opacity-0'
          }`}
          style={{ WebkitTapHighlightColor: 'transparent' }}
          aria-label={t('imageLibrary.close')}
          tabIndex={open ? 0 : -1}
          onClick={() => onClose()}
        />
        <aside
          className={`pointer-events-auto absolute right-0 top-0 flex h-full w-[min(100%,520px)] max-w-[100vw] flex-col border-l border-stone-500/35 bg-[#faf8f5]/98 shadow-[-12px_0_40px_rgba(0,0,0,0.14)] backdrop-blur-md transition-transform duration-300 ease-out dark:border-white/15 dark:bg-[#141418]/98 ${
            entered ? 'translate-x-0' : 'translate-x-full'
          }`}
          role="dialog"
          aria-modal="true"
          aria-labelledby="image-library-title"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-stone-400/35 px-4 py-3 dark:border-slate-600/50">
            <div className="flex min-w-0 items-center gap-2">
              <FiImage className="shrink-0 text-primary-600 dark:text-primary-400" size={18} aria-hidden />
              <h2
                id="image-library-title"
                className="truncate text-sm font-semibold text-stone-900 dark:text-slate-100"
              >
                {t('imageLibrary.title')}
              </h2>
            </div>
            <button
              type="button"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-stone-500 transition-colors hover:bg-stone-200/90 hover:text-stone-800 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-100"
              title={t('imageLibrary.close')}
              aria-label={t('imageLibrary.close')}
              onClick={() => onClose()}
            >
              <FiX size={20} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto overscroll-contain px-3 py-3">
            {loading && thumbs.length === 0 ? (
              <p className="px-1 py-6 text-center text-sm text-stone-500 dark:text-slate-400">
                {t('imageLibrary.loading')}
              </p>
            ) : null}
            {loadErr ? (
              <p className="rounded-lg border border-red-300/55 bg-red-50/95 px-3 py-2 text-xs leading-relaxed text-red-900 dark:border-red-900/55 dark:bg-red-950/50 dark:text-red-100">
                {loadErr}
              </p>
            ) : null}
            {!loading && !loadErr && thumbs.length === 0 ? (
              <p className="px-2 py-8 text-center text-sm text-stone-500 dark:text-slate-400">
                {t('imageLibrary.empty')}
              </p>
            ) : null}
            {thumbs.length > 0 ? (
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {thumbs.map((p, i) => {
                  const href = pathToFileURL(p).href.replace(/^file:/i, 'local-file:');
                  const name =
                    p.replace(/\\/g, '/').split('/').pop() || `${i + 1}`;
                  return (
                    <li key={p} className="min-w-0">
                      <button
                        type="button"
                        className="group flex w-full flex-col overflow-hidden rounded-xl border border-stone-400/35 bg-white/85 text-left shadow-sm transition-all hover:border-primary-500/50 hover:shadow-md dark:border-slate-600/40 dark:bg-slate-900/70"
                        onClick={() => openPreviewAt(i)}
                      >
                        <span className="relative block aspect-square w-full overflow-hidden bg-stone-200/60 dark:bg-slate-800">
                          <img
                            src={href}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
                          />
                        </span>
                        <span className="flex min-h-[2rem] items-center gap-1 border-t border-stone-400/25 px-1.5 py-1 dark:border-slate-600/35">
                          <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-stone-700 dark:text-slate-200">
                            {name}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        </aside>
      </div>

      {previewSlides !== null && previewSlides.length > 0 ? (
        <ConversationImageGalleryModal
          key={`lib-preview-${previewNonce}`}
          slides={previewSlides}
          startIndex={previewStart}
          onClose={() => setPreviewSlides(null)}
        />
      ) : null}
    </>
  );
};

export default ImageLibraryDrawer;
