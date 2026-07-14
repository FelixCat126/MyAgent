import type React from 'react';
import type { ImageGenProgressHooks } from './imageGenAssist';

export function makeImageGenHooks(opts: {
  assistantId: string;
  syncImgGenUi: (v: { current: number; total: number; messageId: string } | null) => void;
  imageGenCancelledRef: React.MutableRefObject<boolean>;
  onImage: (image: { url: string; path: string; width: number; height: number }) => void;
}): ImageGenProgressHooks {
  const { assistantId, syncImgGenUi, imageGenCancelledRef, onImage } = opts;
  return {
    onBegin: ({ total }) => {
      imageGenCancelledRef.current = false;
      syncImgGenUi({ current: 1, total, messageId: assistantId });
    },
    onEachStart: ({ current, total }) => syncImgGenUi({ current, total, messageId: assistantId }),
    onEachDone: ({ done, total }) =>
      syncImgGenUi(
        done >= total
          ? { current: total, total, messageId: assistantId }
          : { current: done + 1, total, messageId: assistantId }
      ),
    onImage: ({ image }) => onImage(image),
    onDone: () => syncImgGenUi(null),
  };
}
