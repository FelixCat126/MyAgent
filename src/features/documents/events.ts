import type { FileInfo } from '../../types/message';
export const DOCUMENT_WORKBENCH_OPEN = 'myagent:document-workbench-open';
export function openDocumentWorkbench(file: FileInfo): void {
  window.dispatchEvent(new CustomEvent(DOCUMENT_WORKBENCH_OPEN, { detail: file }));
}
