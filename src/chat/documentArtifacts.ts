import type { FileInfo } from "../types";
import type { DocumentFormat } from "../types/document";

/** Keep successful files when one format fails; retries only regenerate missing formats. */
export async function generateDocumentArtifacts(
  content: string,
  formats: DocumentFormat[],
  baseName: string,
  existing: FileInfo[] = [],
  shouldCancel = () => false,
) {
  const files = [...existing];
  const errors: string[] = [];
  for (const format of [...new Set(formats)]) {
    if (shouldCancel()) return { files, errors, cancelled: true };
    if (files.some((f) => f.name.toLowerCase().endsWith("." + format)))
      continue;
    try {
      const result = await window.electron.createDocumentArtifact({
        format,
        content,
        defaultBaseName: baseName,
      });
      if (result.ok && result.file?.path && result.file.size > 0)
        files.push(result.file);
      else
        errors.push(
          `${format.toUpperCase()}: ${result.error || "未生成有效文件"}`,
        );
    } catch (e) {
      errors.push(
        `${format.toUpperCase()}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { files, errors, cancelled: shouldCancel() };
}
