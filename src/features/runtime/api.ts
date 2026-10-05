export type TaskStatus = 'queued' | 'running' | 'awaiting_action' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type TaskKind = 'agent' | 'reminder' | 'web-monitor' | 'directory-monitor' | 'image-generation' | 'video-generation' | 'document';
export type JsonObject = Record<string, unknown>;
export interface RuntimeStep { key: string; title: string; status: 'running' | 'completed' | 'failed' | 'interrupted'; result?: unknown; error?: string; updatedAt: number }
export interface RuntimeTask { id: string; title: string; kind: TaskKind; status: TaskStatus; prompt?: string; projectId?: string; checkpoint?: JsonObject; idempotencyKey?: string; steps: RuntimeStep[]; result?: unknown; error?: string; createdAt: number; updatedAt: number }
export interface RuntimeSchedule { id: string; title: string; kind: TaskKind; prompt?: string; projectId?: string; nextRunAt: number; intervalMinutes?: number; enabled: boolean; missedAt?: number; url?: string; directory?: string; fingerprint?: string; lastCheckedAt?: number; lastError?: string }
export interface McpConnection { id: string; name: string; transport: 'stdio' | 'http'; command?: string; args?: string[]; url?: string; env?: Record<string, string>; token?: string; enabled: boolean; status?: 'connected' | 'disconnected'; error?: string }
export interface McpTool { name: string; description?: string; inputSchema: JsonObject; readOnly: boolean; destructive: boolean }
export interface McpCallResult { result?: unknown; authorizationRequired?: { id: string; connectionId: string; tool: string; args: JsonObject; expiresAt: number }; error?: string }
export interface RuntimeSnapshot { tasks: RuntimeTask[]; schedules: RuntimeSchedule[]; connections: McpConnection[]; recoveryError?: string; pendingMcpCalls?: NonNullable<McpCallResult['authorizationRequired']>[] }
export interface BackupPreview { id: string; createdAt: number; files: number; bytes: number; conflicts: string[]; warnings: string[]; repositories: string[] }
export interface RuntimeAPI {
  runtimeGetState(): Promise<RuntimeSnapshot>;
  runtimeCreateTask(input: { title: string; kind: TaskKind; prompt?: string; projectId?: string; checkpoint?: JsonObject; idempotencyKey?: string }): Promise<RuntimeTask>;
  runtimeClaimTask(id: string): Promise<RuntimeTask>;
  runtimeStartTask(id: string): Promise<RuntimeTask>;
  runtimeRetryTask(id: string): Promise<RuntimeTask>;
  runtimeCompleteTask(input: { id: string; result?: unknown; error?: string }): Promise<RuntimeTask>;
  runtimeRecordStep(input: { taskId: string; key: string; title: string; status: RuntimeStep['status']; result?: unknown; error?: string }): Promise<RuntimeTask>;
  runtimeSaveCheckpoint(input: { id: string; checkpoint: JsonObject }): Promise<RuntimeTask>;
  runtimeCancelTask(id: string): Promise<RuntimeTask>;
  runtimeSaveSchedule(input: Omit<RuntimeSchedule, 'id'> & { id?: string }): Promise<RuntimeSchedule>;
  runtimeDeleteSchedule(id: string): Promise<void>;
  runtimeRunSchedule(id: string): Promise<RuntimeTask>;
  runtimeChooseDirectory(): Promise<string | null>;
  runtimeSaveConnection(input: Omit<McpConnection, 'status' | 'error'>): Promise<McpConnection>;
  runtimeConnect(id: string): Promise<McpTool[]>;
  runtimeDisconnect(id: string): Promise<void>;
  runtimeDeleteConnection(id: string): Promise<void>;
  runtimeListTools(id: string): Promise<McpTool[]>;
  runtimeCallTool(input: { connectionId: string; tool: string; args: JsonObject }): Promise<McpCallResult>;
  runtimeApproveMcpCall(id: string): Promise<McpCallResult>;
  runtimeCancelMcpCall(id: string): Promise<void>;
  runtimeExportBackup(input: { password: string }): Promise<{ path: string | null; files?: number; bytes?: number }>;
  runtimePreviewBackup(input: { password: string }): Promise<BackupPreview | null>;
  runtimeRestoreBackup(input: { previewId: string; mode: 'merge' | 'replace' }): Promise<{ restartRequired: boolean; rollbackId: string }>;
  runtimeListSnapshots(): Promise<Array<{ id: string; createdAt: number; label: string }>>;
  runtimeRollbackBackup(id: string): Promise<{ restartRequired: boolean }>;
  onRuntimeChanged(callback: (snapshot: RuntimeSnapshot) => void): () => void;
  onRuntimeTaskDispatch(callback: (task: RuntimeTask) => void): () => void;
  onRuntimeMcpResult(callback: (event: { approvalId: string; result: McpCallResult }) => void): () => void;
  onRuntimeTaskCancel(callback: (id: string) => void): () => void;
}
