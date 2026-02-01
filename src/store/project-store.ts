/**
 * Project Store
 *
 * Global state management for the selected project path.
 * Persisted to localStorage so the project is remembered across sessions.
 * Recent projects (last 5) stored for quick re-selection.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const MAX_RECENT_PROJECTS = 5;

interface ProjectStore {
  projectPath: string | null;
  recentPaths: string[];
  /** Incremented when worktrees change; used to refresh sidebar count. Not persisted. */
  worktreeRefreshKey: number;
  setProjectPath: (path: string | null) => void;
  addRecentPath: (path: string) => void;
  incrementWorktreeRefresh: () => void;
}

export const useProjectStore = create<ProjectStore>()(
  persist(
    (set) => ({
      projectPath: null,
      recentPaths: [],
      worktreeRefreshKey: 0,
      setProjectPath: (path) => set({ projectPath: path }),
      addRecentPath: (path) =>
        set((state) => {
          const trimmed = path.trim();
          if (!trimmed) return state;
          const filtered = state.recentPaths.filter((p) => p !== trimmed);
          const updated = [trimmed, ...filtered].slice(0, MAX_RECENT_PROJECTS);
          return { recentPaths: updated };
        }),
      incrementWorktreeRefresh: () =>
        set((s) => ({ worktreeRefreshKey: (s.worktreeRefreshKey ?? 0) + 1 })),
    }),
    {
      name: 'code-auto-project',
      partialize: (state) => ({
        projectPath: state.projectPath,
        recentPaths: state.recentPaths,
      }),
    }
  )
);
