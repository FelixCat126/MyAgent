export function boundedText(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string') {
    if (required) throw new Error('required');
    return '';
  }
  const text = value.trim();
  if (required && !text) throw new Error('required');
  if (text.length > max) throw new Error('too-long');
  if (text.includes('\0')) throw new Error('invalid-text');
  return text;
}

export function validateProjectPath(value: unknown): string {
  const path = boundedText(value, 4096);
  if (path && !/^(?:\/|~\/|[a-zA-Z]:[\\/]|\\\\)/.test(path)) {
    throw new Error('absolute-path');
  }
  return path;
}

export function finiteTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function memoryTokens(text: string): string[] {
  const lower = text.toLocaleLowerCase();
  const words: string[] = lower.match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [];
  const runs: string[] = lower.match(/[\u3400-\u9fff]{2,}/g) ?? [];
  for (const run of runs) {
    for (let i = 0; i < run.length - 1; i += 1) words.push(run.slice(i, i + 2));
  }
  return [...new Set(words)].slice(0, 100);
}
