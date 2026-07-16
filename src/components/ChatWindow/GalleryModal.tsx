import React from 'react';
import { ConversationImageGalleryModal } from '../MessageItem';
import type { ConversationImageGalleryItem } from '../../utils/conversationImageGallery';

export interface GalleryModalProps {
  slides: ConversationImageGalleryItem[];
  startIndex: number | null;
  nonce: number;
  /** 用于重置 key 的会话/全局标识 */
  resetKey: string;
  onClose: () => void;
}

/**
 * 包装 ConversationImageGalleryModal 调用。
 * 仅当 startIndex !== null 且 slides 不为空时渲染。
 */
export const GalleryModal: React.FC<GalleryModalProps> = (p) => {
  if (p.startIndex === null || p.slides.length === 0) return null;
  return (
    <ConversationImageGalleryModal
      key={`${p.resetKey}-${p.nonce}`}
      slides={p.slides}
      startIndex={p.startIndex}
      onClose={p.onClose}
    />
  );
};