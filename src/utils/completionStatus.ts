/** Provider completion metadata; missing metadata must not be guessed from prose. */
export function completionWasTruncated(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const value = data as { choices?: Array<{ finish_reason?: string }>; delta?: { stop_reason?: string }; stop_reason?: string; candidates?: Array<{ finishReason?: string }> };
  return ['length', 'max_tokens', 'MAX_TOKENS'].includes(value.choices?.[0]?.finish_reason ?? value.delta?.stop_reason ?? value.stop_reason ?? value.candidates?.[0]?.finishReason ?? '');
}
