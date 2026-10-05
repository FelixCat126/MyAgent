import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { zustandPersistJson } from '../utils/zustandFileStorage';
import { newId } from '../utils/newId';
import { boundedText, finiteTimestamp, validateProjectPath } from '../features/personal/validation';
import type { PersonalProject } from '../features/personal/types';
import { PERSIST_KEYS } from '../utils/persistKeys';

export const PROJECT_PERSIST_KEY = PERSIST_KEYS.project;
type ProjectInput = Pick<PersonalProject, 'name'> & Partial<Pick<PersonalProject, 'description' | 'rootPath' | 'rules'>>;

function normalizeProject(input: ProjectInput): Omit<PersonalProject, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: boundedText(input.name, 80, true),
    description: boundedText(input.description, 1000),
    rootPath: validateProjectPath(input.rootPath),
    rules: boundedText(input.rules, 16000),
  };
}

export function restoreProjects(value: unknown): PersonalProject[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((raw) => {
    try {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || seen.has(raw.id)) return [];
      const fields = normalizeProject(raw);
      seen.add(raw.id);
      const createdAt = finiteTimestamp(raw.createdAt, Date.now());
      return [{ ...fields, id: raw.id, createdAt, updatedAt: finiteTimestamp(raw.updatedAt, createdAt) }];
    } catch { return []; }
  });
}

interface ProjectStore {
  projects: PersonalProject[];
  activeProjectId: string | null;
  createProject: (input: ProjectInput) => string;
  updateProject: (id: string, patch: Partial<ProjectInput>) => void;
  deleteProject: (id: string) => void;
  setActiveProject: (id: string | null) => void;
}

export const useProjectStore = create<ProjectStore>()(persist((set, get) => ({
  projects: [],
  activeProjectId: null,
  createProject: (input) => {
    const fields = normalizeProject(input);
    if (get().projects.some((p) => p.name.toLocaleLowerCase() === fields.name.toLocaleLowerCase())) throw new Error('duplicate-name');
    const id = newId();
    const now = Date.now();
    set((s) => ({ projects: [{ ...fields, id, createdAt: now, updatedAt: now }, ...s.projects], activeProjectId: id }));
    return id;
  },
  updateProject: (id, patch) => {
    const project = get().projects.find((p) => p.id === id);
    if (!project) throw new Error('missing-project');
    const fields = normalizeProject({ ...project, ...patch });
    if (get().projects.some((p) => p.id !== id && p.name.toLocaleLowerCase() === fields.name.toLocaleLowerCase())) throw new Error('duplicate-name');
    set((s) => ({ projects: s.projects.map((p) => p.id === id ? { ...p, ...fields, updatedAt: Date.now() } : p) }));
  },
  deleteProject: (id) => set((s) => ({ projects: s.projects.filter((p) => p.id !== id), activeProjectId: s.activeProjectId === id ? null : s.activeProjectId })),
  setActiveProject: (id) => set({ activeProjectId: id && get().projects.some((p) => p.id === id) ? id : null }),
}), {
  name: PROJECT_PERSIST_KEY,
  version: 1,
  storage: zustandPersistJson,
  partialize: (s) => ({ projects: s.projects, activeProjectId: s.activeProjectId }),
  merge: (raw, current) => {
    const state = raw as Partial<ProjectStore> | undefined;
    const projects = restoreProjects(state?.projects);
    return { ...current, projects, activeProjectId: projects.some((p) => p.id === state?.activeProjectId) ? state!.activeProjectId! : null };
  },
}));
