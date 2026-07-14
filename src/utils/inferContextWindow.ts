import type { ModelConfig } from '../types';

/**
 * 粗算：中英混合场景下「字符 → 约 token」。
 * 进度条/压缩用本地启发式，不追求精确 tokenizer。
 */
export const APPROX_CHARS_PER_TOKEN = 2;

/**
 * 产品约定：全应用统一按 1M token 估算本地软上限。
 * 这是刻意的产品边界（非 tokenizer / 非厂商真实窗口），进度条与压缩共用。
 */
export const UNIFIED_CONTEXT_WINDOW_TOKENS = 1_000_000;

/** 产品软上限字符数（1M × APPROX_CHARS_PER_TOKEN） */
export const PRODUCT_CONTEXT_SOFT_LIMIT_CHARS =
  UNIFIED_CONTEXT_WINDOW_TOKENS * APPROX_CHARS_PER_TOKEN;

/**
 * 上下文窗口（token）。按产品约定统一 1M，不再按厂商分支。
 */
export function inferContextWindowTokens(_input?: {
  provider?: string;
  apiUrl?: string;
  modelName?: string;
}): number {
  return UNIFIED_CONTEXT_WINDOW_TOKENS;
}

export function contextWindowTokensToSoftLimitChars(tokens: number): number {
  const t = Math.max(1_024, Math.floor(tokens));
  return t * APPROX_CHARS_PER_TOKEN;
}

/** 当前模型的本地软上限（字符），供进度条与压缩共用 */
export function resolveContextSoftLimitChars(
  _model?: Pick<ModelConfig, 'provider' | 'apiUrl' | 'modelName'> | null
): number {
  return PRODUCT_CONTEXT_SOFT_LIMIT_CHARS;
}
