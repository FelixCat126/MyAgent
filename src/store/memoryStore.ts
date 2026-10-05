import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { zustandPersistJson } from '../utils/zustandFileStorage';
import { newId } from '../utils/newId';
import { boundedText, finiteTimestamp, memoryTokens } from '../features/personal/validation';
import type { MemorySource, PersonalMemory } from '../features/personal/types';
import { PERSIST_KEYS } from '../utils/persistKeys';

export const MEMORY_PERSIST_KEY = PERSIST_KEYS.memory;
export type MemoryInput = Pick<PersonalMemory, 'content' | 'scope'> & Partial<Omit<PersonalMemory, 'id' | 'content' | 'scope' | 'createdAt' | 'updatedAt'>>;

function normalizeMemory(input: MemoryInput) {
  const content = boundedText(input.content, 4000, true);
  if (input.scope !== 'personal' && input.scope !== 'project') throw new Error('invalid-scope');
  const projectId = input.scope === 'project' ? boundedText(input.projectId, 200, true) : null;
  const rawSource = input.source;
  const source: MemorySource = { kind: rawSource?.kind === 'message' ? 'message' : 'manual' };
  if (rawSource?.sessionId) source.sessionId = boundedText(rawSource.sessionId, 200);
  if (rawSource?.messageId) source.messageId = boundedText(rawSource.messageId, 200);
  if (rawSource?.title) source.title = boundedText(rawSource.title, 200);
  return {
    content,
    scope: input.scope,
    projectId,
    status: input.status === 'candidate' ? 'candidate' as const : 'confirmed' as const,
    kind: input.kind === 'preference' ? 'preference' as const : 'fact' as const,
    keywords: Array.isArray(input.keywords)
      ? [...new Set(input.keywords.filter((x): x is string => typeof x === 'string').map((x) => x.trim().toLowerCase()).filter(Boolean))].slice(0, 100)
      : memoryTokens(content),
    alwaysApply: input.alwaysApply === true,
    source,
  };
}

export function restoreMemories(value: unknown): PersonalMemory[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((raw) => {
    try {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || seen.has(raw.id)) return [];
      if (raw.status !== 'confirmed' && raw.status !== 'candidate') return [];
      const normalized = normalizeMemory(raw);
      seen.add(raw.id);
      const createdAt = finiteTimestamp(raw.createdAt, Date.now());
      return [{ ...normalized, id: raw.id, createdAt, updatedAt: finiteTimestamp(raw.updatedAt, createdAt) }];
    } catch { return []; }
  });
}

interface MemoryStore {
  memories: PersonalMemory[];
  candidateExtractionEnabled: boolean;
  addMemory: (input: MemoryInput) => string;
  updateMemory: (id: string, patch: Partial<MemoryInput>) => void;
  approveMemory: (id: string) => void;
  deleteMemory: (id: string) => void;
  setCandidateExtractionEnabled: (enabled: boolean) => void;
}

export const useMemoryStore = create<MemoryStore>()(persist((set, get) => ({
  memories: [],
  candidateExtractionEnabled: true,
  addMemory: (input) => {
    const normalized = normalizeMemory(input);
    const existing = get().memories.find((m) => m.scope === normalized.scope && m.projectId === normalized.projectId && m.content.toLocaleLowerCase() === normalized.content.toLocaleLowerCase());
    if (existing) {
      // An explicit remember can approve a previously proposed candidate.
      if (normalized.status === 'confirmed' && existing.status === 'candidate') get().updateMemory(existing.id, normalized);
      return existing.id;
    }
    const id = newId();
    const now = Date.now();
    set((s) => ({ memories: [{ ...normalized, id, createdAt: now, updatedAt: now }, ...s.memories] }));
    return id;
  },
  updateMemory: (id, patch) => {
    const memory = get().memories.find((m) => m.id === id);
    if (!memory) return;
    const input = { ...memory, ...patch };
    if (patch.content !== undefined && patch.keywords === undefined) input.keywords = memoryTokens(patch.content);
    const normalized = normalizeMemory(input);
    set((s) => ({ memories: s.memories.map((m) => m.id === id ? { ...m, ...normalized, updatedAt: Date.now() } : m) }));
  },
  approveMemory: (id) => get().updateMemory(id, { status: 'confirmed' }),
  deleteMemory: (id) => set((s) => ({ memories: s.memories.filter((m) => m.id !== id) })),
  setCandidateExtractionEnabled: (enabled) => set({ candidateExtractionEnabled: enabled }),
}), {
  name: MEMORY_PERSIST_KEY,
  version: 1,
  storage: zustandPersistJson,
  partialize: (s) => ({ memories: s.memories, candidateExtractionEnabled: s.candidateExtractionEnabled }),
  merge: (raw, current) => {
    const state = raw as Partial<MemoryStore> | undefined;
    return { ...current, memories: restoreMemories(state?.memories), candidateExtractionEnabled: state?.candidateExtractionEnabled !== false };
  },
}));
