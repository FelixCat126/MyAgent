/**
 * 会话级图片画廊 modal（轮播主图 + 左右滑动 + 删除当前图 + 桌面壳另存）。
 *
 * 抽离自 MessageItem.tsx（行 196-413），行为与拆分前完全一致。
 *
 * 关键技术细节：
 * - 内部包含 GalleryCarouselStage 3D 轮播舞台（紧密耦合，独占使用）
 * - 拖拽 / 滑动由 useGallerySwipeMomentum 控制（RAF 动量衰减）
 * - 鼠标滚轮 + 键盘左右箭头 + 上一张/下一张按钮四向交互
 * - 手势 UI phase 在打开时设置 gallery-preview，关闭时复位 idle
 * - 关闭有 240ms 渐隐 → setTimeout onClose
 * - 桌面壳独占"另存图片"按钮；可选"删除当前图"按钮（仅传 onDeleteCurrent 时显示）
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FiDownload, FiTrash2, FiX, FiChevronLeft, FiChevronRight } from 'react-icons/fi';
import { useI18n } from '../../hooks/useI18n';
import { useGallerySwipeMomentum } from '../../hooks/useGallerySwipeMomentum';
import { galleryCarouselCardMetricsSmooth } from '@/utils/galleryCarouselLayout';
import { setGestureUiPhase } from '@/utils/gestureUiContext';
import {
  DownloadLocalFileError,
  downloadDisplayImage,
  hasDesktopLocalSaveCapability,
} from '../../utils/imageDownload';
import { showError } from '../../store/errorStore';
import {
  GALLERY_CAROUSEL_TRANSITION,
  GALLERY_IMG_FRAME,
  GALLERY_IMG,
  GALLERY_MODAL_ENTER_MS,
  MODAL_CLEAR_TITLEBAR_PT,
  MODAL_PORTAL_LAYER_CLASS,
  MODAL_PORTAL_SHELL_STYLE,
  PREVIEW_IMG_TOUCH_MENU_STYLE as previewImgTouchMenuStyle,
} from './styleConstants';
import type { ConversationImageGalleryItem } from '../../utils/conversationImageGallery';

interface GalleryCarouselStageProps {
  slides: ConversationImageGalleryItem[];
  scrollPos: number;
  isDragging: boolean;
  onSelect: (index: number) => void;
  altFallback: string;
  touchMenuStyle?: React.CSSProperties;
  stageRef?: React.Ref<HTMLDivElement>;
}

const GalleryCarouselStage: React.FC<GalleryCarouselStageProps> = ({
  slides,
  scrollPos,
  isDragging,
  onSelect,
  altFallback,
  touchMenuStyle,
  stageRef,
}) => {
  const cardTransitionStyle: React.CSSProperties = {
    transition: isDragging ? 'none' : GALLERY_CAROUSEL_TRANSITION,
    transformStyle: 'preserve-3d',
  };

  const minI = Math.max(0, Math.floor(scrollPos) - 3);
  const maxI = Math.min(slides.length - 1, Math.ceil(scrollPos) + 3);

  return (
    <div
      ref={stageRef}
      className="relative mx-auto h-[min(72vh,880px)] w-full min-w-0 max-w-[min(78vw,1080px)]"
      style={{ perspective: '1500px', perspectiveOrigin: '50% 45%' }}
    >
      <div className="relative h-full w-full" style={{ transformStyle: 'preserve-3d' }}>
        {Array.from({ length: maxI - minI + 1 }, (_, k) => minI + k).map((slideIndex) => {
          const slide = slides[slideIndex]!;
          const offset = slideIndex - scrollPos;
          const metrics = galleryCarouselCardMetricsSmooth(offset);
          const isCenter = Math.abs(offset) < 0.45;
          const img = (
            <div className={GALLERY_IMG_FRAME}>
              <img
                src={slide.src}
                alt={isCenter ? slide.defaultFileName || altFallback : ''}
                aria-hidden={!isCenter}
                draggable={false}
                style={touchMenuStyle}
                className={GALLERY_IMG}
              />
            </div>
          );

          if (isCenter) {
            return (
              <div
                key={`${slide.messageId}-${slide.fileIndex}-${slideIndex}`}
                className="absolute left-1/2 top-1/2 origin-center"
                style={{
                  ...cardTransitionStyle,
                  transform: metrics.transform,
                  opacity: metrics.opacity,
                  zIndex: metrics.zIndex,
                  pointerEvents: metrics.pointerEvents,
                }}
              >
                {img}
              </div>
            );
          }

          return (
            <button
              key={`${slide.messageId}-${slide.fileIndex}-${slideIndex}`}
              type="button"
              aria-label={slide.defaultFileName || altFallback}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(slideIndex);
              }}
              className="absolute left-1/2 top-1/2 origin-center cursor-pointer rounded-lg border-0 bg-transparent p-0 outline-none transition-[filter] hover:brightness-105 focus-visible:ring-2 focus-visible:ring-white/50"
              style={{
                ...cardTransitionStyle,
                transform: metrics.transform,
                opacity: metrics.opacity,
                zIndex: metrics.zIndex,
                pointerEvents: metrics.pointerEvents,
              }}
            >
              {img}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export interface ConversationImageGalleryModalProps {
  slides: ConversationImageGalleryItem[];
  startIndex: number;
  onClose: () => void;
  onDeleteCurrent?: (slide: ConversationImageGalleryItem) => void | Promise<void>;
}

export const ConversationImageGalleryModal: React.FC<ConversationImageGalleryModalProps> = ({
  slides,
  startIndex,
  onClose,
  onDeleteCurrent,
}) => {
  const { t } = useI18n();
  const desktopShell = hasDesktopLocalSaveCapability();
  const stageRef = useRef<HTMLDivElement>(null);
  const { scrollPos, settledIndex, setIndex, isDragging } = useGallerySwipeMomentum(
    slides.length,
    startIndex
  );
  const [shown, setShown] = useState(false);
  const closingRef = useRef(false);
  const displayIndex = Math.min(
    slides.length - 1,
    Math.max(0, Math.round(scrollPos))
  );

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

  useEffect(() => {
    setGestureUiPhase('gallery-preview');
    return () => {
      setGestureUiPhase('idle');
    };
  }, []);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (delta === 0) return;
      if (delta > 0) {
        setIndex(Math.min(slides.length - 1, settledIndex + 1));
      } else {
        setIndex(Math.max(0, settledIndex - 1));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [slides.length, settledIndex, setIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose();
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setIndex(Math.max(0, settledIndex - 1));
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setIndex(Math.min(slides.length - 1, settledIndex + 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [slides.length, requestClose, settledIndex, setIndex]);

  if (!slides.length) return null;

  const slide = slides[displayIndex]!;
  const canPrev = scrollPos > 0.02;
  const canNext = scrollPos < slides.length - 1.02;

  const handleGallerySaveCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await downloadDisplayImage({
        src: slide.src.trim(),
        sourceLocalPath: slide.localPath.trim(),
        defaultFileName: slide.defaultFileName || 'image.png',
      });
    } catch (err) {
      if (err instanceof DownloadLocalFileError) {
        showError(
          err.code === 'path_empty' ? 'message.downloadPathEmpty' : 'message.downloadSourceMissing'
        );
        return;
      }
      console.warn('[image-download] gallery save failed');
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
      aria-label={t('message.imageAlt')}
    >
      <div
        className="relative isolate flex h-full max-h-screen min-h-0 w-full max-w-[100vw] flex-col px-12 sm:px-16"
        onClick={(e) => e.stopPropagation()}
        style={{
          transform: shown ? 'scale(1) translateY(0)' : 'scale(0.94) translateY(14px)',
          transition: `transform ${GALLERY_MODAL_ENTER_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`,
        }}
      >
        <div
          className={`pointer-events-auto relative z-[210] flex w-full shrink-0 flex-wrap justify-end gap-3 pb-4 [&_svg]:pointer-events-none sm:pb-5 ${MODAL_CLEAR_TITLEBAR_PT}`}
        >
          {desktopShell ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md bg-white/10 px-2.5 py-1 text-sm text-white backdrop-blur-sm transition-colors hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/55"
              title={t('message.imagePreviewDownload')}
              aria-label={t('message.imagePreviewDownload')}
              onClick={(e) => void handleGallerySaveCopy(e)}
            >
              <FiDownload size={14} aria-hidden />
              <span>{t('message.imagePreviewDownload')}</span>
            </button>
          ) : null}
          {onDeleteCurrent ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md bg-red-500/20 px-2.5 py-1 text-sm text-white backdrop-blur-sm transition-colors hover:bg-red-500/35 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/55"
              title={t('imageLibrary.delete')}
              onClick={(e) => {
                e.stopPropagation();
                void onDeleteCurrent(slide);
              }}
            >
              <FiTrash2 size={14} aria-hidden />
              <span>{t('imageLibrary.delete')}</span>
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

        <div className="pointer-events-none relative z-0 flex min-h-0 w-full max-w-[min(96vw,1400px)] flex-1 items-center justify-center gap-1 self-center sm:gap-2">
          <button
            type="button"
            disabled={!canPrev}
            onClick={(e) => {
              e.stopPropagation();
              setIndex(Math.max(0, settledIndex - 1));
            }}
            className={`pointer-events-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/25 bg-white/10 text-white transition-colors sm:h-12 sm:w-12 [&_svg]:pointer-events-none ${
              canPrev ? 'hover:bg-white/20' : 'cursor-not-allowed opacity-35'
            }`}
            title={t('message.imageGalleryPrev')}
            aria-label={t('message.imageGalleryPrev')}
          >
            <FiChevronLeft size={22} aria-hidden />
          </button>

          <div className="pointer-events-auto flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3">
            <GalleryCarouselStage
              slides={slides}
              scrollPos={scrollPos}
              isDragging={isDragging}
              onSelect={setIndex}
              altFallback={t('message.imageAlt')}
              touchMenuStyle={desktopShell ? undefined : previewImgTouchMenuStyle}
              stageRef={stageRef}
            />
            <p className="text-center text-sm text-white/90 tabular-nums">
              {t('message.imageGalleryPosition', { current: displayIndex + 1, total: slides.length })}
            </p>
            {!desktopShell ? (
              <p className="mx-auto max-w-[min(90vw,24rem)] text-center text-[11px] leading-snug text-white/55 px-2">
                {t('message.imageLongPressGalleryHint')}
              </p>
            ) : null}
          </div>

          <button
            type="button"
            disabled={!canNext}
            onClick={(e) => {
              e.stopPropagation();
              setIndex(Math.min(slides.length - 1, settledIndex + 1));
            }}
            className={`pointer-events-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/25 bg-white/10 text-white transition-colors sm:h-12 sm:w-12 [&_svg]:pointer-events-none ${
              canNext ? 'hover:bg-white/20' : 'cursor-not-allowed opacity-35'
            }`}
            title={t('message.imageGalleryNext')}
            aria-label={t('message.imageGalleryNext')}
          >
            <FiChevronRight size={22} aria-hidden />
        </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(node, document.body) : null;
};

export default ConversationImageGalleryModal;
