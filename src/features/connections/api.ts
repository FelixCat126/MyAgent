import type { Message, ModelConfig } from '../../types';

export type NativeToolCall = { id: string; name: string; arguments: Record<string, unknown> };
export type NativeToolDefinition = { name: string; description: string; parameters: Record<string, unknown> };
export type ModelRoundResult = { content: string; reasoning?: string; toolCalls?: NativeToolCall[]; nativeTools: boolean; assistantBlocks?: Array<Record<string, unknown>> };
export type DiagnosticCheck = { kind: 'chat' | 'history' | 'stream' | 'tools' | 'vision'; status: 'verified' | 'failed' | 'unverified'; elapsedMs?: number; detail?: string };
export type ModelDiagnosticReport = { checkedAt: number; checks: DiagnosticCheck[] };
export interface ModelServiceAPI {
  discoverServiceModels: (config: Pick<ModelConfig, 'provider' | 'apiUrl' | 'apiKey' | 'chatApiMode'>) => Promise<{ models: Array<{ id: string; capabilities?: string[] }>; error?: string }>;
  diagnoseModel: (config: ModelConfig, checks?: DiagnosticCheck['kind'][]) => Promise<ModelDiagnosticReport>;
  callAgentModel: (arg: { requestId: string; config: ModelConfig; messages: Message[]; tools: NativeToolDefinition[]; stream?: boolean }) => Promise<ModelRoundResult>;
  abortAgentModel: (requestId: string) => void;
}
