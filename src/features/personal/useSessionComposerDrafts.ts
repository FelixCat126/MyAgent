import { useLayoutEffect, useRef } from 'react';

interface Draft { input: string; files: File[] }
/** Switching conversations preserves each unsent text and attachment draft. */
export function useSessionComposerDrafts(options: {
  sessionId: string | null;
  input: string;
  files: File[];
  setInput: (value: string) => void;
  setFiles: (files: File[]) => void;
  setPreviews: (previews: Record<string, string>) => void;
}) {
  const drafts = useRef(new Map<string, Draft>());
  const previousSession = useRef(options.sessionId);
  const latest = useRef({ input: options.input, files: options.files });
  latest.current = { input: options.input, files: options.files };
  useLayoutEffect(() => {
    if (previousSession.current === options.sessionId) return;
    if (previousSession.current) drafts.current.set(previousSession.current, latest.current);
    previousSession.current = options.sessionId;
    const restored = options.sessionId ? drafts.current.get(options.sessionId) : undefined;
    options.setInput(restored?.input ?? '');
    const files = restored?.files ?? [];
    options.setFiles(files);
    options.setPreviews(Object.fromEntries(files.filter((file) => file.type.startsWith('image/')).map((file) => [file.name, URL.createObjectURL(file)])));
    // Setters intentionally run only when the authoritative session id changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.sessionId]);
  return {
    clearDraft: (sessionId: string) => drafts.current.delete(sessionId),
    setDraft: (sessionId: string, draft: Draft) => drafts.current.set(sessionId, draft),
  };
}
