import type { ModelConfig } from '../types';

export const APPROX_CHARS_PER_TOKEN = 2;
/** Unknown service capability: use a conservative input budget, never claim a 1M window. */
export const UNIFIED_CONTEXT_WINDOW_TOKENS = 32_768;
export const PRODUCT_CONTEXT_SOFT_LIMIT_CHARS = (UNIFIED_CONTEXT_WINDOW_TOKENS - 4096) * APPROX_CHARS_PER_TOKEN;
type ContextModel = Partial<Pick<ModelConfig, 'provider' | 'apiUrl' | 'modelName' | 'contextWindowTokens' | 'maxTokens'>>;

/** Known, stable remote model limits. Explicit user configuration always wins. */
function inferKnownRemoteContextWindow(input?: ContextModel): number | null {
  const model = String(input?.modelName ?? '').trim().toLowerCase();
  const url = String(input?.apiUrl ?? '').trim().toLowerCase();

  if (model === 'minimax-m3' || model.startsWith('minimax-m3-')) return 1_000_000;
  if (model === 'k3-256k') return 262_144;
  if (
    model === 'k3' ||
    model === 'kimi-k3' ||
    model === 'k3[1m]' ||
    ((url.includes('kimi.com') || url.includes('kimi.ai')) && model.includes('k3'))
  ) return 1_000_000;
  return null;
}

export function inferContextWindowTokens(input?: ContextModel): number {
  const configured = input?.contextWindowTokens;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 1024) return Math.floor(configured);
  const knownRemote = inferKnownRemoteContextWindow(input);
  if (knownRemote) return knownRemote;
  return input?.provider === 'ollama' ? 8192 : UNIFIED_CONTEXT_WINDOW_TOKENS;
}
export function contextWindowTokensToSoftLimitChars(tokens: number): number {
  return Math.max(1024, Math.floor(tokens)) * APPROX_CHARS_PER_TOKEN;
}
export function resolveContextSoftLimitChars(model?: ContextModel | null): number {
  const window = inferContextWindowTokens(model ?? undefined);
  const output = Math.min(Math.max(1, model?.maxTokens || 4096), Math.floor(window / 2));
  return contextWindowTokensToSoftLimitChars(window - output);
}
