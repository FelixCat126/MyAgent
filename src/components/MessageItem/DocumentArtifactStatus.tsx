import { useI18n } from "../../hooks/useI18n";
import { useState } from "react";
import type { Message } from "../../types";
import { useChatStore } from "../../store/chatStore";
import { generateDocumentArtifacts } from "../../chat/documentArtifacts";
import {
  documentArtifactBaseNameFromContent,
  documentExportFormatsFromHint,
} from "../../utils/documentExportIntent";

export function DocumentArtifactStatus({ message }: { message: Message }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const hint = message.exportHint;
  if (hint?.status !== "failed") return null;
  const retry = async () => {
    if (busy || !hint.sourceContent) return;
    const store = useChatStore.getState();
    const session = store.sessions.find((s) =>
      s.messages.some((m) => m.id === message.id),
    );
    if (!session) return;
    setBusy(true);
    try {
      const result = await generateDocumentArtifacts(
        hint.sourceContent,
        documentExportFormatsFromHint(hint),
        documentArtifactBaseNameFromContent(hint.sourceContent),
        message.files,
      );
      store.updateMessage(session.id, message.id, {
        content: result.errors.length
          ? hint.sourceContent
          : t("document.ready"),
        files: result.files,
        exportHint: {
          ...hint,
          status: result.errors.length ? "failed" : "ready",
          error: result.errors.join("；") || undefined,
        },
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      role="status"
      className="mt-3 rounded-lg border border-amber-300/60 bg-amber-50/70 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200"
    >
      <p className="font-medium">{t("document.incomplete")}</p>
      <p className="mt-1 whitespace-pre-wrap break-words">
        {hint.error || t("document.failed")}
      </p>
      {hint.sourceContent && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void retry()}
          className="mt-2 rounded-md border border-amber-400/60 px-3 py-1.5 font-medium hover:bg-amber-100 disabled:opacity-50 dark:hover:bg-amber-900"
        >
          {busy ? t("document.generating") : t("document.retry")}
        </button>
      )}
    </div>
  );
}
