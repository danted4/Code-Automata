/**
 * Live agent output, fanned out from the event stream to whatever view is following a task (the
 * run log viewer). Nothing is kept: a view that opens later replays the run's log instead.
 */

import type { AgentEvent } from '@/lib/api/types/AgentEvent';

/** `log` is the run log the event belongs to; `seq` is its number there, as on the log line. */
export type LiveAgentEvent = {
  taskId: string;
  runId: string;
  log: string;
  seq: number;
  event: AgentEvent;
  at: number;
};

type Listener = (e: LiveAgentEvent) => void;

const listeners = new Map<string, Set<Listener>>();

export function publishAgentEvent(e: LiveAgentEvent) {
  listeners.get(e.taskId)?.forEach((l) => l(e));
}

/** Follow one task's agent output; returns the function that stops following. */
export function onAgentEvent(taskId: string, listener: Listener): () => void {
  let set = listeners.get(taskId);
  if (!set) {
    set = new Set();
    listeners.set(taskId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(taskId);
  };
}
