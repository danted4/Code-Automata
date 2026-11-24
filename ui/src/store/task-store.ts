/**
 * Task Store (Zustand)
 *
 * Global state management for tasks and Kanban board
 */

import { create } from 'zustand';
import { Task, WorkflowPhase } from '@/lib/tasks/schema';
import { apiFetch } from '@/lib/api-client';

interface TaskState {
  tasks: Task[];
  isLoading: boolean;
  error: string | null;

  // Actions
  loadTasks: () => Promise<void>;
  createTask: (task: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>) => Promise<Task>;
  updateTask: (taskId: string, updates: Partial<Task>) => Promise<void>;
  updateTaskPhase: (taskId: string, phase: WorkflowPhase) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
}

export const useTaskStore = create<TaskState>((set, _get) => ({
  tasks: [],
  isLoading: false,
  error: null,

  loadTasks: async () => {
    set({ isLoading: true, error: null });
    const doLoad = async (attempt = 0): Promise<void> => {
      const maxRetries = 2; // 3 total attempts: 0, 1, 2
      const retryDelays = [1000, 2500]; // Give a backend that is still starting a moment
      try {
        const response = await apiFetch('/api/tasks/list');
        if (!response.ok) {
          throw new Error('Failed to load tasks');
        }
        const tasks = await response.json();
        set({ tasks, isLoading: false });
      } catch (error) {
        if (attempt < maxRetries) {
          const delay = retryDelays[attempt] ?? 1500;
          setTimeout(() => doLoad(attempt + 1), delay);
        } else {
          set({
            error: error instanceof Error ? error.message : 'Unknown error',
            isLoading: false,
          });
        }
      }
    };
    doLoad();
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
    set({ isLoading: true, error: null });
    try {
      const response = await apiFetch('/api/tasks/update', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, phase }),
      });

      if (!response.ok) {
        throw new Error('Failed to update task phase');
      }

      set((state) => ({
        tasks: state.tasks.map((t) =>
          t.id === taskId ? { ...t, phase, updatedAt: Date.now() } : t
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
