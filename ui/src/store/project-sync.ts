/**
 * Keeps the stores in step with the open project: follows its event stream, reloads the task list
 * after every (re)connect, applies task changes, and fans agent output out to listeners.
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api/client';
import { followEvents, type StreamState } from '@/lib/api/events';
import type { Settings } from '@/lib/api/types/Settings';
import type { ServerEvent } from '@/lib/api/types/ServerEvent';
import { publishAgentEvent } from '@/lib/agent-events';
import { useProjectStore } from '@/store/project-store';
import { useTaskStore } from '@/store/task-store';
import { useTaskViewStore } from '@/store/task-view-store';

interface SyncState {
  stream: StreamState;
  /** Why the server refused the stream, while it does. */
  streamError: string | null;
  /** The project's settings, for labels such as "Reworking (n/m)"; null until loaded. */
  settings: Settings | null;
  setSettings: (s: Settings | null) => void;
}

export const useSyncStore = create<SyncState>((set) => ({
  stream: 'closed',
  streamError: null,
  settings: null,
  setSettings: (settings) => set({ settings }),
}));

function handle(project: string, event: ServerEvent) {
  if (useProjectStore.getState().projectPath !== project) return;
  const tasks = useTaskStore.getState();
  switch (event.type) {
    case 'hello':
    case 'lagged':
      void tasks.load();
      break;
    case 'task':
      if (event.task) tasks.upsert(event.task);
      else tasks.remove(event.taskId);
      break;
    case 'reload':
      api.tasks
        .get(event.taskId)
        .then((t) => {
          if (useProjectStore.getState().projectPath === project) useTaskStore.getState().upsert(t);
        })
        .catch((e) => {
          if (
            e instanceof ApiError &&
            e.status === 404 &&
            useProjectStore.getState().projectPath === project
          )
            useTaskStore.getState().remove(event.taskId);
        });
      break;
    case 'agent':
      publishAgentEvent({
        taskId: event.taskId,
        runId: event.runId,
        seq: event.seq,
        event: event.event,
        at: Date.now(),
      });
      break;
    case 'error':
      toast.error(`Task ${event.taskId}: ${event.message}`);
      break;
  }
}

/** Mount once, in the layout. */
export function useProjectSync() {
  const projectPath = useProjectStore((s) => s.projectPath);

  useEffect(() => {
    useTaskStore.getState().clear();
    useTaskViewStore.getState().close();
    useSyncStore.getState().setSettings(null);
    if (!projectPath) return;
    api.settings
      .get()
      .then((r) => {
        if (useProjectStore.getState().projectPath === projectPath) {
          useSyncStore.getState().setSettings(r.settings);
        }
      })
      .catch(() => {});
    return followEvents(projectPath, {
      onEvent: (event) => handle(projectPath, event),
      onState: (stream, reason) =>
        useSyncStore.setState({
          stream,
          streamError: stream === 'refused' ? (reason ?? null) : null,
        }),
    });
  }, [projectPath]);
}
