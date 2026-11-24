/**
 * The open project's tasks, kept current by the server's event stream.
 *
 * `load` fetches the list; `useProjectSync` (in the layout) follows the event stream and calls
 * `load` after every (re)connect, then applies task changes as they arrive. Commands go through
 * `act`, which stores the task the server returns and turns failures into toasts.
 *
 * Responses and events can arrive out of order (a list read before a change can land after the
 * change's event), so the store keeps whichever copy of a task is newest: the server raises
 * `updatedAt` on every write. A task deleted since a list was read is not brought back by it.
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
  /** Store a copy of a task unless a newer one is already stored. */
  upsert: (task: Task) => void;
  remove: (id: string) => void;
  clear: () => void;
}

/** The list request currently out, if any, and the project it is for. */
let inFlight: { project: string | null; done: Promise<void> } | null = null;
/** Tasks removed recently, with when: a list read before the removal must not restore them. */
const removedAt = new Map<string, number>();
const REMOVED_MEMORY_MS = 5 * 60_000;
/** Retry a failed list load: 1 s, 2 s, 5 s, then every 10 s. */
const RETRY_MS = [1000, 2000, 5000, 10_000];
let retry: { timer: ReturnType<typeof setTimeout>; attempt: number } | null = null;

function newer(incoming: Task, stored: Task | undefined): boolean {
  return !stored || incoming.updatedAt >= stored.updatedAt;
}

/** Merge a list read at `requestedAt` into what the store holds now. */
export function mergeList(
  current: Task[],
  listed: Task[],
  requestedAt: number,
  removed: ReadonlyMap<string, number>
): Task[] {
  const byId = new Map(current.map((t) => [t.id, t]));
  const out: Task[] = [];
  for (const t of listed) {
    const gone = removed.get(t.id);
    if (gone !== undefined && gone >= requestedAt) continue; // deleted after the read
    const stored = byId.get(t.id);
    out.push(newer(t, stored) ? t : (stored as Task));
    byId.delete(t.id);
  }
  // Tasks the list does not have: keep those created or changed after the read began.
  for (const t of byId.values()) {
    if (t.updatedAt >= requestedAt) out.unshift(t);
  }
  return out;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  skipped: [],
  loading: false,
  error: null,

  load: () => {
    const project = useProjectStore.getState().projectPath;
    if (inFlight && inFlight.project === project) return inFlight.done;
    if (retry) {
      clearTimeout(retry.timer);
    }
    if (!project) {
      retry = null;
      set({ tasks: [], skipped: [], loading: false, error: null });
      return Promise.resolve();
    }
    set({ loading: true });
    const attempt = retry?.attempt ?? 0;
    retry = null;
    const entry: { project: string | null; done: Promise<void> } = {
      project,
      done: Promise.resolve(),
    };
    entry.done = (async () => {
      const requestedAt = Date.now();
      try {
        const list = await api.tasks.list();
        if (useProjectStore.getState().projectPath !== project) return;
        set({
          tasks: mergeList(get().tasks, list.tasks, requestedAt, removedAt),
          skipped: list.skipped,
          loading: false,
          error: null,
        });
      } catch (e) {
        if (useProjectStore.getState().projectPath !== project) return;
        set({ loading: false, error: errorMessage(e) });
        // The stream may stay open, so nothing else would ask again.
        const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
        retry = { attempt: attempt + 1, timer: setTimeout(() => void get().load(), wait) };
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
      if (i === -1) {
        const gone = removedAt.get(task.id);
        // A copy older than the removal (a late response) must not bring it back.
        if (gone !== undefined && task.updatedAt <= gone) return state;
        return { tasks: [task, ...state.tasks] };
      }
      if (!newer(task, state.tasks[i])) return state;
      const tasks = state.tasks.slice();
      tasks[i] = task;
      return { tasks };
    }),

  remove: (id) => {
    const now = Date.now();
    removedAt.set(id, now);
    for (const [k, at] of removedAt) if (now - at > REMOVED_MEMORY_MS) removedAt.delete(k);
    set((state) => ({ tasks: state.tasks.filter((t) => t.id !== id) }));
  },

  clear: () => {
    if (retry) clearTimeout(retry.timer);
    retry = null;
    removedAt.clear();
    set({ tasks: [], skipped: [], error: null });
  },
}));

/**
 * Run a command that returns the task, store the result, and toast a failure. Resolves to the
 * task, or null when the command failed. A result for a project that is no longer open is not
 * stored.
 */
export async function act(command: () => Promise<Task>, success?: string): Promise<Task | null> {
  const project = useProjectStore.getState().projectPath;
  try {
    const task = await command();
    if (useProjectStore.getState().projectPath === project) {
      useTaskStore.getState().upsert(task);
    }
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
