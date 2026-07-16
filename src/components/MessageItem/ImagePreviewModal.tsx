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
  GALLERY_IMG_FRAME,
  GALLERY_IMG,
  MODAL_PORTAL_LAYER_CLASS,
  MODAL_PORTAL_SHELL_STYLE,
  PREVIEW_IMG_TOUCH_MENU_STYLE,
} from './styleConstants';

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
    >
      <div
        className="relative isolate flex max-h-[85vh] w-full max-w-[90vw] flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
        style={{
          transform: shown ? 'scale(1) translateY(0)' : 'scale(0.94) translateY(14px)',
          transition: `transform ${GALLERY_MODAL_ENTER_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`,
        }}
      >
        <div className="pointer-events-auto relative z-[210] flex shrink-0 justify-end gap-3 [&_svg]:pointer-events-none">
          {desktopShell ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md bg-white/10 px-2.5 py-1 text-sm text-white backdrop-blur-sm transition-colors hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/55"
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
          className="inline-flex items-center justify-center rounded-md bg-white/10 px-2 py-1 text-white backdrop-blur-sm transition-colors hover:bg-white/20 hover:text-primary-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/55"
          title={t('message.closePreview')}
          aria-label={t('message.closePreview')}
        >
          <FiX size={18} aria-hidden />
        </button>
        </div>
        <div className={`mx-auto ${GALLERY_IMG_FRAME}`}>
          <img
            src={src}
            alt={alt}
            style={desktopShell ? undefined : PREVIEW_IMG_TOUCH_MENU_STYLE}
            className={GALLERY_IMG}
          />
        </div>
        {!desktopShell ? (
          <p className="mx-auto max-w-[min(90vw,24rem)] text-center text-[11px] leading-snug text-white/55 px-2">
            {t('message.imageLongPressGalleryHint')}
          </p>
        ) : null}
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(node, document.body) : null;
};

export default ImagePreviewModal;
