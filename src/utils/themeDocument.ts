export function applyBodyClassForStoredTheme(
  theme: 'light' | 'dark' | 'system' | undefined
): void {
  if (typeof document === 'undefined') return;
  if (theme === 'system' || theme === undefined) {
    if (typeof window === 'undefined' || !window.matchMedia) {
      document.body.classList.remove('dark');
      return;
    }
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.body.classList.toggle('dark', dark);
    return;
  }
  document.body.classList.toggle('dark', theme === 'dark');
}
