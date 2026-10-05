import type { FileInfo } from '../../types/message';
import type { DocumentFormat } from '../../types/document';

export type DocumentPage = { page: number; text: string; method: 'text' | 'ocr' | 'failed'; confidence?: number; warning?: string; error?: string };
export type TableCell = { address: string; value: string | number | boolean | null; formula?: string };
export type TablePreview = { sheet: string; range: string; columns: string[]; rows: TableCell[][]; totalRows: number; truncated: boolean; warnings: string[] };
export type DocumentVersion = { id: string; parentId?: string; createdAt: number; label: string; format: string; file: FileInfo; exports?: FileInfo[]; content?: string; truncated?: boolean };
export type WorkbenchDocument = { id: string; sourcePath: string; sourceMissing: boolean; title: string; kind: string; content: string; editable: boolean; editNotice?: string; pages?: DocumentPage[]; table?: TablePreview; sheets?: string[]; versions: DocumentVersion[]; activeVersionId: string; truncated?: boolean };
export type InspectDocumentRequest = { path: string; name?: string; sheet?: string; range?: string; ocr?: boolean; requestId?: string };
export type SaveDocumentRequest = { documentId: string; baseVersionId: string; content?: string; cells?: { sheet: string; address: string; value: string | number | boolean | null }[]; label?: string; formats?: DocumentFormat[]; requestId?: string };
export type DataScalar = string | number | boolean | null;
export type DataStep =
  | { op: 'filter'; column: string; operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains'; value: DataScalar }
  | { op: 'select'; columns: string[] }
  | { op: 'dedupe'; columns?: string[] }
  | { op: 'group'; by: string[]; aggregates: { column?: string; function: 'sum' | 'avg' | 'count' | 'min' | 'max'; as: string }[] }
  | { op: 'yoy'; yearColumn: string; valueColumn: string; by?: string[]; as?: string };
export type DataCalculationRequest = { path: string; sheet?: string; range?: string; steps: DataStep[]; chart?: { type: 'bar' | 'line'; x: string; y: string; title?: string }; requestId?: string; scope?: { scoped: boolean; root?: string; deniedPaths?: string[]; attachmentPaths?: string[] } };
export type DataCalculationResult = { columns: string[]; rows: Record<string, DataScalar>[]; warnings: string[]; source: { path: string; sheet: string; range: string }; files: FileInfo[]; chartSvg?: string };
export type WorkbenchResult<T> = ({ ok: true } & T) | { ok: false; error: string; canceled?: boolean };
export interface DocumentWorkbenchAPI {
  inspectDocument: (arg: InspectDocumentRequest) => Promise<WorkbenchResult<{ document: WorkbenchDocument }>>;
  renderDocumentPage: (arg: { path: string; page: number; requestId?: string }) => Promise<WorkbenchResult<{ image: string; width: number; height: number }>>;
  saveDocumentVersion: (arg: SaveDocumentRequest) => Promise<WorkbenchResult<{ document: WorkbenchDocument; files: FileInfo[] }>>;
  restoreDocumentVersion: (arg: { documentId: string; versionId: string; requestId?: string }) => Promise<WorkbenchResult<{ document: WorkbenchDocument; files: FileInfo[] }>>;
  compareDocumentVersions: (arg: { documentId: string; leftId: string; rightId: string }) => Promise<WorkbenchResult<{ left: string; right: string; leftLabel: string; rightLabel: string }>>;
  calculateDocumentData: (arg: DataCalculationRequest) => Promise<WorkbenchResult<{ result: DataCalculationResult }>>;
  cancelDocumentOperation: (requestId: string) => void;
}
