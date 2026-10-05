import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { zustandPersistJson } from '../utils/zustandFileStorage';
import { newId } from '../utils/newId';
import { boundedText, finiteTimestamp } from '../features/personal/validation';
import type { PersonalWorkflow, WorkflowOutput, WorkflowVariable } from '../features/personal/types';
import { PERSIST_KEYS } from '../utils/persistKeys';

export const WORKFLOW_PERSIST_KEY = PERSIST_KEYS.workflow;
const FORMATS: WorkflowOutput[] = ['auto', 'markdown', 'txt', 'docx', 'pdf', 'xlsx', 'csv', 'pptx', 'html', 'json'];
type WorkflowInput = Pick<PersonalWorkflow, 'name' | 'template'> & Partial<Pick<PersonalWorkflow, 'description' | 'projectId' | 'variables' | 'outputFormat' | 'sourceSessionId' | 'sourceMessageId'>>;

export function workflowVariableNames(template: string): string[] {
  return [...new Set([...template.matchAll(/\{\{\s*([\p{L}\p{N}_-]{1,40})\s*\}\}/gu)].map((match) => match[1]))];
}

function normalizeWorkflow(input: WorkflowInput) {
  const template = boundedText(input.template, 24000, true);
  const variables: WorkflowVariable[] = workflowVariableNames(template).map((name) => {
    const existing = input.variables?.find((v) => v.name === name);
    return { name, label: boundedText(existing?.label || name, 80, true), defaultValue: boundedText(existing?.defaultValue, 8000), required: existing?.required !== false };
  });
  if (variables.length > 20) throw new Error('too-many-variables');
  if (/\{\{|\}\}/.test(template.replace(/\{\{\s*[\p{L}\p{N}_-]{1,40}\s*\}\}/gu, ''))) throw new Error('invalid-variable');
  return {
    name: boundedText(input.name, 80, true),
    description: boundedText(input.description, 1000),
    template,
    variables,
    outputFormat: FORMATS.includes(input.outputFormat!) ? input.outputFormat! : 'auto' as const,
    projectId: input.projectId ? boundedText(input.projectId, 200) : null,
    sourceSessionId: input.sourceSessionId ? boundedText(input.sourceSessionId, 200) : undefined,
    sourceMessageId: input.sourceMessageId ? boundedText(input.sourceMessageId, 200) : undefined,
  };
}

export function renderWorkflow(workflow: PersonalWorkflow, values: Record<string, string>, locale: 'zh' | 'en' = 'zh'): string {
  const inputs = new Map(workflow.variables.map((variable) => {
    const value = boundedText(values[variable.name] ?? variable.defaultValue, 8000, variable.required);
    return [variable.name, value];
  }));
  const rendered = workflow.template.replace(/\{\{\s*([\p{L}\p{N}_-]{1,40})\s*\}\}/gu, (_, name: string) => inputs.get(name) ?? '');
  if (rendered.length > 64000) throw new Error('too-long');
  if (workflow.outputFormat === 'auto') return rendered;
  return rendered + (locale === 'zh'
    ? `\n\n请将最终成果生成为 ${workflow.outputFormat.toUpperCase()} 文件，并提供可点击下载的文件。`
    : `\n\nGenerate the final result as a ${workflow.outputFormat.toUpperCase()} file and provide a clickable download.`);
}

export function restoreWorkflows(value: unknown): PersonalWorkflow[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((raw) => {
    try {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || seen.has(raw.id)) return [];
      const normalized = normalizeWorkflow(raw);
      seen.add(raw.id);
      const createdAt = finiteTimestamp(raw.createdAt, Date.now());
      return [{ ...normalized, id: raw.id, createdAt, updatedAt: finiteTimestamp(raw.updatedAt, createdAt), lastRunAt: finiteTimestamp(raw.lastRunAt, 0) || undefined, runCount: Math.max(0, Math.floor(Number(raw.runCount) || 0)) }];
    } catch { return []; }
  });
}

interface WorkflowStore {
  workflows: PersonalWorkflow[];
  createWorkflow: (input: WorkflowInput) => string;
  updateWorkflow: (id: string, patch: Partial<WorkflowInput>) => void;
  deleteWorkflow: (id: string) => void;
  detachProjectWorkflows: (projectId: string) => void;
  markWorkflowRun: (id: string) => void;
}

export const useWorkflowStore = create<WorkflowStore>()(persist((set, get) => ({
  workflows: [],
  createWorkflow: (input) => {
    const normalized = normalizeWorkflow({ ...input, projectId: null });
    const id = newId();
    const now = Date.now();
    set((s) => ({ workflows: [{ ...normalized, id, createdAt: now, updatedAt: now, runCount: 0 }, ...s.workflows] }));
    return id;
  },
  updateWorkflow: (id, patch) => {
    const workflow = get().workflows.find((w) => w.id === id);
    if (!workflow) return;
    const normalized = normalizeWorkflow({ ...workflow, ...patch, projectId: patch.projectId === null ? null : workflow.projectId });
    set((s) => ({ workflows: s.workflows.map((w) => w.id === id ? { ...w, ...normalized, updatedAt: Date.now() } : w) }));
  },
  deleteWorkflow: (id) => set((s) => ({ workflows: s.workflows.filter((w) => w.id !== id) })),
  detachProjectWorkflows: (projectId) => set((s) => ({ workflows: s.workflows.map((w) => w.projectId === projectId ? { ...w, projectId: null, updatedAt: Date.now() } : w) })),
  markWorkflowRun: (id) => set((s) => ({ workflows: s.workflows.map((w) => w.id === id ? { ...w, runCount: w.runCount + 1, lastRunAt: Date.now() } : w) })),
}), {
  name: WORKFLOW_PERSIST_KEY,
  version: 1,
  storage: zustandPersistJson,
  partialize: (s) => ({ workflows: s.workflows }),
  merge: (raw, current) => ({ ...current, workflows: restoreWorkflows((raw as Partial<WorkflowStore> | undefined)?.workflows) }),
}));
