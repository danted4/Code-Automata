/**
 * The open project's tasks, kept current by the server's event stream.
 *
 * `load` fetches the list; `useProjectSync` (in the layout) follows the event stream and calls
 * `load` after every (re)connect, then applies task changes as they arrive. Commands go through
 * `act`, which stores the task the server returns and turns failures into toasts.
 */

import { create } from 'zustand';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import type { SkippedFile } from '@/lib/api/types/SkippedFile';
import type { Task } from '@/lib/api/types/Task';
import { useProjectStore } from '@/store/project-store';

interface TaskState {
  tasks: Task[];
  /** Task files the server could not read. */
  skipped: SkippedFile[];
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  upsert: (task: Task) => void;
  remove: (id: string) => void;
  clear: () => void;
}

/** The list request currently out, if any, and the project it is for. */
let inFlight: { project: string | null; done: Promise<void> } | null = null;

export const useTaskStore = create<TaskState>((set) => ({
  tasks: [],
  skipped: [],
  loading: false,
  error: null,

  load: () => {
    const project = useProjectStore.getState().projectPath;
    if (inFlight && inFlight.project === project) return inFlight.done;
    if (!project) {
      set({ tasks: [], skipped: [], loading: false, error: null });
      return Promise.resolve();
    }
    set({ loading: true });
    const entry: { project: string | null; done: Promise<void> } = {
      project,
      done: Promise.resolve(),
    };
    entry.done = (async () => {
      try {
        const list = await api.tasks.list();
        if (useProjectStore.getState().projectPath !== project) return;
        set({ tasks: list.tasks, skipped: list.skipped, loading: false, error: null });
      } catch (e) {
        if (useProjectStore.getState().projectPath !== project) return;
        set({ loading: false, error: errorMessage(e) });
      } finally {
        if (inFlight === entry) inFlight = null;
      }
    })();
    inFlight = entry;
    return entry.done;
  },

  upsert: (task) =>
    set((state) => {
      const i = state.tasks.findIndex((t) => t.id === task.id);
      if (i === -1) return { tasks: [task, ...state.tasks] };
      const tasks = state.tasks.slice();
      tasks[i] = task;
      return { tasks };
    }),

  remove: (id) => set((state) => ({ tasks: state.tasks.filter((t) => t.id !== id) })),

  clear: () => set({ tasks: [], skipped: [], error: null }),
}));

/**
 * Run a command that returns the task, store the result, and toast a failure. Resolves to the
 * task, or null when the command failed.
 */
export async function act(command: () => Promise<Task>, success?: string): Promise<Task | null> {
  try {
    const task = await command();
    useTaskStore.getState().upsert(task);
    if (success) toast.success(success);
    return task;
  } catch (e) {
    toast.error(errorMessage(e));
    return null;
  }
}

/** The task with this id from the store, kept current. */
export function useTask(id: string | null | undefined): Task | undefined {
  return useTaskStore((s) => (id ? s.tasks.find((t) => t.id === id) : undefined));
}
