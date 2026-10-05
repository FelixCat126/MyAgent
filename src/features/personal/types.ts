export interface PersonalProject {
  id: string;
  name: string;
  description: string;
  rootPath: string;
  rules: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemorySource {
  kind: 'manual' | 'message';
  sessionId?: string;
  messageId?: string;
  title?: string;
}

export interface PersonalMemory {
  id: string;
  content: string;
  scope: 'personal' | 'project';
  projectId: string | null;
  status: 'candidate' | 'confirmed';
  kind: 'preference' | 'fact';
  keywords: string[];
  /** Only explicitly chosen general reply preferences bypass relevance matching. */
  alwaysApply: boolean;
  source: MemorySource;
  createdAt: number;
  updatedAt: number;
}

export type WorkflowOutput = 'auto' | 'markdown' | 'txt' | 'docx' | 'pdf' | 'xlsx' | 'csv' | 'pptx' | 'html' | 'json';
export interface WorkflowVariable {
  name: string;
  label: string;
  defaultValue: string;
  required: boolean;
}
export interface PersonalWorkflow {
  id: string;
  name: string;
  description: string;
  template: string;
  variables: WorkflowVariable[];
  outputFormat: WorkflowOutput;
  projectId: string | null;
  sourceSessionId?: string;
  sourceMessageId?: string;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  runCount: number;
}

export interface WorkflowRunRequest {
  prompt: string;
  projectId: string | null;
  workflowId: string;
}
