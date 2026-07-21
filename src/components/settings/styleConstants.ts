/**
 * 设置区表单样式常量（ModelsSection 曾 15+ 处逐字重复）。
 * 与 MessageItem/styleConstants 同一模式；所有值与原字面值完全一致。
 */

/** 大输入框（名称/API 地址/密钥/模型名等主字段） */
export const FORM_INPUT_LG =
  'w-full px-3 py-2 border border-stone-400/35 dark:border-gray-600 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-stone-100/90 dark:bg-gray-700 text-stone-900 dark:text-white';

/** 小输入框（生图工具区字段） */
export const FORM_INPUT_SM =
  'w-full px-2.5 py-1.5 border border-stone-400/25 dark:border-gray-600 rounded-md text-xs focus:outline-none focus:ring-1 focus:ring-primary-500 bg-stone-100/90 dark:bg-slate-700 text-stone-900 dark:text-white';

/** 小下拉框（与 INPUT_SM 同构，font-medium） */
export const FORM_SELECT_SM =
  'w-full px-2.5 py-1.5 border border-stone-400/25 dark:border-gray-600 rounded-md text-xs font-medium focus:outline-none focus:ring-1 focus:ring-primary-500 bg-stone-100/90 dark:bg-slate-700 text-stone-900 dark:text-white';

/** 等宽小输入框（env/命令行等多行技术字段，行高宽松） */
export const FORM_INPUT_SM_MONO =
  'w-full px-2.5 py-1.5 border border-stone-400/25 dark:border-gray-600 rounded-md text-[10px] font-mono leading-snug bg-stone-50/90 dark:bg-slate-800 text-stone-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-primary-500';

/** 等宽小输入框（紧凑行高变体） */
export const FORM_INPUT_SM_MONO_TIGHT =
  'w-full px-2.5 py-1.5 border border-stone-400/25 dark:border-gray-600 rounded-md text-[10px] font-mono leading-tight bg-stone-50/90 dark:bg-slate-800 text-stone-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-primary-500';

/** 常规字段标签 */
export const FORM_LABEL =
  'block text-xs font-medium text-stone-700 dark:text-gray-300 mb-1';

/** 生图工具区小字段标签 */
export const FORM_LABEL_SM =
  'block text-[10px] font-medium text-stone-700 dark:text-gray-400 mb-1';
