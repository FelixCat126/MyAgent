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

/** 会话图库 modal 进入动画时长（ms） */
export const GALLERY_MODAL_ENTER_MS = 240;
