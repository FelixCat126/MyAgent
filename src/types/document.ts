export const DOCUMENT_FORMATS = [
  "md",
  "docx",
  "xlsx",
  "pdf",
  "txt",
  "csv",
] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];
export function isDocumentFormat(value: unknown): value is DocumentFormat {
  return (
    typeof value === "string" &&
    (DOCUMENT_FORMATS as readonly string[]).includes(value)
  );
}
