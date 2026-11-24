/**
 * Task Store (Zustand)
 *
 * Global state management for tasks and Kanban board
 */

import { create } from 'zustand';
import { Task, WorkflowPhase } from '@/lib/tasks/schema';
import { apiFetch } from '@/lib/api-client';
import { useProjectStore } from '@/store/project-store';

interface TaskState {
  tasks: Task[];
  isLoading: boolean;
  error: string | null;

  // Actions
  loadTasks: () => Promise<void>;
  createTask: (task: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>) => Promise<Task>;
  updateTask: (taskId: string, updates: Partial<Task>) => Promise<void>;
  /** Resolves to null on success, else the reason the move was refused or failed. */
  updateTaskPhase: (taskId: string, phase: WorkflowPhase) => Promise<string | null>;
  deleteTask: (taskId: string) => Promise<void>;
}

/** The task-list request currently out, if any, and the project it is for. */
let inFlight: { project: string | null; token: object; done: Promise<void> } | null = null;

export const useTaskStore = create<TaskState>((set, _get) => ({
  tasks: [],
  isLoading: false,
  error: null,

  loadTasks: () => {
    // The board polls every few seconds; a poll that arrives while a load for the same project is
    // still out joins it instead of starting a second request.
    const project = useProjectStore.getState().projectPath;
    if (inFlight && inFlight.project === project) return inFlight.done;
    set({ isLoading: true, error: null });
    const token = {};
    const done = (async () => {
      try {
        const response = await apiFetch('/api/tasks/list', { projectPath: project });
        if (!response.ok) {
          throw new Error('Failed to load tasks');
        }
        const tasks = await response.json();
        // A project switched while this was out: its own load sets the list.
        if (useProjectStore.getState().projectPath !== project) return;
        set({ tasks, isLoading: false });
      } catch (error) {
        if (useProjectStore.getState().projectPath !== project) return;
        set({
          error: error instanceof Error ? error.message : 'Unknown error',
          isLoading: false,
        });
      } finally {
        if (inFlight?.token === token) inFlight = null;
      }
    })();
    inFlight = { project, token, done };
    return done;
  },

  createTask: async (taskData) => {
    set({ isLoading: true, error: null });
    try {
      const response = await apiFetch('/api/tasks/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(taskData),
      });

      if (!response.ok) {
        throw new Error('Failed to create task');
      }

      const task = await response.json();
      set((state) => ({
        tasks: [...state.tasks, task],
        isLoading: false,
      }));

      return task;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Unknown error',
        isLoading: false,
      });
      throw error;
    }
  },

  updateTask: async (taskId, updates) => {
    set({ isLoading: true, error: null });
    try {
      const response = await apiFetch('/api/tasks/update', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, ...updates }),
      });

      if (!response.ok) {
        throw new Error('Failed to update task');
      }

      set((state) => ({
        tasks: state.tasks.map((t) =>
          t.id === taskId ? { ...t, ...updates, updatedAt: Date.now() } : t
        ),
        isLoading: false,
      }));
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Unknown error',
        isLoading: false,
      });
    }
  },

  updateTaskPhase: async (taskId, phase) => {
    try {
      const response = await apiFetch('/api/tasks/update', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, phase }),
      });
      if (!response.ok) {
        const body: { error?: unknown } = await response.json().catch(() => ({}));
        return typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
      }
      set((state) => ({
        tasks: state.tasks.map((t) =>
          t.id === taskId ? { ...t, phase, updatedAt: Date.now() } : t
        ),
      }));
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'Unknown error';
    }
  },

  deleteTask: async (taskId) => {
    set({ isLoading: true, error: null });
    try {
      const response = await apiFetch(`/api/tasks/delete?taskId=${taskId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to delete task');
      }

      set((state) => ({
        tasks: state.tasks.filter((t) => t.id !== taskId),
        isLoading: false,
      }));
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Unknown error',
        isLoading: false,
      });
    }
  },
}));
