/**
 * 单图预览 modal（点开图片时全屏显示）。
 *
 * 抽离自 MessageItem.tsx（第 239-343 行），行为与拆分前完全一致。
 *
 * 依赖：
 * - 桌面壳：另存拷贝（走 downloadDisplayImage）
 * - 移动壳：无长按菜单，使用 WebKitTouchCallout
 *
 * 关闭动画：点击外部 / 关闭按钮 → 0.94 缩放 + 0 透明度（240ms）
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FiDownload, FiX } from 'react-icons/fi';
import { useI18n } from '../../hooks/useI18n';
import { DownloadLocalFileError, downloadDisplayImage, hasDesktopLocalSaveCapability } from '../../utils/imageDownload';
import { showError } from '../../store/errorStore';
import {
  GALLERY_MODAL_ENTER_MS,
  MODAL_CLEAR_TITLEBAR_PT,
  MODAL_PORTAL_LAYER_CLASS,
  MODAL_PORTAL_SHELL_STYLE,
  PREVIEW_IMG_TOUCH_MENU_STYLE,
} from './styleConstants';
import { artifactDisplayName } from './DocumentAttachmentCard';

export interface ImagePreviewModalProps {
  src: string;
  onClose: () => void;
  alt: string;
  /** 桌面壳另存拷贝用；移动端壳无 Electron 时使用长按菜单 */
  localPath?: string;
  defaultFileName?: string;
}

export const ImagePreviewModal: React.FC<ImagePreviewModalProps> = ({
  src,
  onClose,
  alt,
  localPath,
  defaultFileName,
}) => {
  const { t } = useI18n();
  const desktopShell = hasDesktopLocalSaveCapability();
  const displayName = artifactDisplayName(
    defaultFileName || alt || t('message.imageAlt'),
    t('message.imageAlt'),
  );
  const [shown, setShown] = useState(false);
  const closingRef = useRef(false);

  useEffect(() => {
    const id = window.requestAnimationFrame(() => setShown(true));
    return () => window.cancelAnimationFrame(id);
  }, []);

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setShown(false);
    window.setTimeout(onClose, GALLERY_MODAL_ENTER_MS);
  }, [onClose]);

  const handleSaveCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await downloadDisplayImage({
        src: src.trim(),
        sourceLocalPath: (localPath || '').trim(),
        defaultFileName: defaultFileName || 'image.png',
      });
    } catch (err) {
      if (err instanceof DownloadLocalFileError) {
        showError(
          err.code === 'path_empty' ? 'message.downloadPathEmpty' : 'message.downloadSourceMissing'
        );
        return;
      }
      console.warn('[image-download] preview save failed');
      showError('message.imageDownloadFailed');
    }
  };

  const node = (
    <div
      className={MODAL_PORTAL_LAYER_CLASS}
      style={{
        ...MODAL_PORTAL_SHELL_STYLE,
        opacity: shown ? 1 : 0,
        transitionDuration: `${GALLERY_MODAL_ENTER_MS}ms`,
      }}
      onClick={requestClose}
      role="dialog"
      aria-modal="true"
      aria-label={displayName}
    >
      <div
        className="relative isolate flex h-full max-h-screen min-h-0 w-full max-w-[100vw] flex-col px-4 sm:px-8"
        onClick={(e) => e.stopPropagation()}
        style={{
          transform: shown ? 'scale(1) translateY(0)' : 'scale(0.94) translateY(14px)',
          transition: `transform ${GALLERY_MODAL_ENTER_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`,
        }}
      >
        <div className={`pointer-events-auto relative z-[210] flex shrink-0 items-center justify-between gap-4 pb-4 ${MODAL_CLEAR_TITLEBAR_PT}`}>
          <p className="min-w-0 truncate text-sm font-medium text-white/85" title={defaultFileName || alt}>
            {displayName}
          </p>
          <div className="flex shrink-0 items-center gap-2 [&_svg]:pointer-events-none">
            {desktopShell ? (
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/10 px-3 py-1.5 text-sm text-white backdrop-blur-sm transition-colors hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/55"
                title={t('message.imagePreviewDownload')}
                aria-label={t('message.imagePreviewDownload')}
                onClick={(e) => void handleSaveCopy(e)}
              >
                <FiDownload size={14} aria-hidden />
                <span>{t('message.imagePreviewDownload')}</span>
              </button>
            ) : null}
            <button
              type="button"
              onClick={requestClose}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/15 bg-white/10 text-white backdrop-blur-sm transition-colors hover:bg-white/20 hover:text-primary-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/55"
              title={t('message.closePreview')}
              aria-label={t('message.closePreview')}
            >
              <FiX size={18} aria-hidden />
            </button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 pb-6">
          <div className="flex max-h-[82vh] max-w-[92vw] items-center justify-center overflow-hidden rounded-xl bg-zinc-950 shadow-2xl ring-1 ring-white/10">
            <img
              src={src}
              alt={alt}
              style={desktopShell ? undefined : PREVIEW_IMG_TOUCH_MENU_STYLE}
              className="block max-h-[82vh] max-w-[92vw] object-contain"
            />
          </div>
          {!desktopShell ? (
            <p className="mx-auto max-w-[min(90vw,24rem)] px-2 text-center text-[11px] leading-snug text-white/55">
              {t('message.imageLongPressGalleryHint')}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(node, document.body) : null;
};

export default ImagePreviewModal;
