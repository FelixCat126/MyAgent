/**
 * MessageItem 样式常量集中管理。
 *
 * 抽离原因：原本散落在 1389 行的 MessageItem.tsx 中的 Tailwind class 字符串常量
 * 重复使用（≥10 处）且命名风格不一（GRID/IMG/PT/CLASS 混用），
 * 集中后便于维护。**所有值与原文件字面值完全一致**。
 */

import type React from 'react';

/** 渲染 Markdown 内容的最大字符数（超过则跳过正文预处理） */
export const MAX_MARKDOWN_RENDER_CHARS = 24_000;

/** 助手消息预处理的字符上限 */
export const MAX_ASSISTANT_PREPROCESS_CHARS = 28_000;

/** 多图附件与生图占位共用：每行 4 张，不足一行从左排，超过 4 自动换行；缩略尺寸一致避免生成前后跳动 */
export const MULTI_IMAGE_ATTACHMENT_GRID =
  'grid w-max max-w-full grid-cols-[repeat(4,max-content)] gap-2 justify-items-start overflow-x-auto';

/** 单个附件缩略图容器样式（尺寸） */
export const ASSISTANT_IMAGE_THUMB_FRAME =
  'h-[90px] w-[120px] shrink-0 sm:h-[112px] sm:w-[150px]';

/** 单个附件缩略图图片元素样式（继承 FRAME + 图片专属） */
export const ASSISTANT_IMAGE_THUMB_IMG =
  `${ASSISTANT_IMAGE_THUMB_FRAME} cursor-zoom-in rounded-md object-contain border border-stone-300/60 shadow-sm transition-transform hover:scale-[1.02] dark:border-white/10`;

/** 单个附件缩略图元信息行样式 */
export const ASSISTANT_IMAGE_THUMB_META_ROW =
  'flex min-h-[calc(15px+0.125rem)] w-[120px] items-center gap-1 sm:w-[150px]';

/** 对应 App.tsx 顶栏拖拽区 TITLEBAR_H(44)，避免按钮落在 Electron drag 带上被吞点击 */
export const MODAL_CLEAR_TITLEBAR_PT = 'pt-[52px]';

/** modal portal 容器样式 */
export const MODAL_PORTAL_LAYER_CLASS =
  'fixed inset-0 z-[10010] flex items-center justify-center bg-black transition-opacity';

/** modal portal shell style（用于 drag region） */
export const MODAL_PORTAL_SHELL_STYLE: React.CSSProperties & { WebkitAppRegion?: string } = {
  WebkitAppRegion: 'no-drag',
};

/** 预览大图：启用系统长按菜单（存储图像等）；WebKit 专有属性 */
export const PREVIEW_IMG_TOUCH_MENU_STYLE: React.CSSProperties = {
  WebkitTouchCallout: 'default',
  WebkitUserSelect: 'none',
  userSelect: 'none',
};

/** 会话图库轮播切换 transition（transform + opacity） */
export const GALLERY_CAROUSEL_TRANSITION =
  'transform 520ms cubic-bezier(0.32, 0.72, 0, 1), opacity 520ms ease';

/** 会话图库 modal 进入动画时长（ms） */
export const GALLERY_MODAL_ENTER_MS = 240;

/** 会话图库单图容器 */
export const GALLERY_IMG_FRAME =
  'flex max-h-[min(72vh,880px)] max-w-[min(72vw,920px)] items-center justify-center overflow-hidden rounded-lg bg-white shadow-2xl dark:bg-zinc-900';

/** 会话图库图片元素 */
export const GALLERY_IMG =
  'block max-h-[min(72vh,880px)] max-w-[min(72vw,920px)] object-contain';
