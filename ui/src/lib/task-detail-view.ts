/**
 * What the task detail view shows beyond the card: subtask rows in order, which one is running,
 * which can be skipped, and the hint for actions that open another view.
 */

import type { Subtask } from '@/lib/api/types/Subtask';
import type { Task } from '@/lib/api/types/Task';
import { ACTION_LABELS, isWorking, type PrimaryAction } from '@/lib/task-view';

export type SubtaskRow = {
  subtask: Subtask;
  /** The step in progress works on this subtask. */
  running: boolean;
  /** A step is on this subtask (working or halted): skipping drops its partial work. */
  current: boolean;
  canSkip: boolean;
};

/** Dev subtasks then QA subtasks, each in execution order. */
export function subtaskRows(task: Task): { dev: SubtaskRow[]; qa: SubtaskRow[] } {
  const currentId = task.run?.subtaskId ?? null;
  const working = isWorking(task);
  const row = (s: Subtask): SubtaskRow => ({
    subtask: s,
    current: s.id === currentId,
    running: working && s.id === currentId,
    canSkip: s.status === 'pending',
  });
  const subs = task.subtasks ?? [];
  return {
    dev: subs.filter((s) => s.kind === 'dev').map(row),
    qa: subs.filter((s) => s.kind === 'qa').map(row),
  };
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '';
}

/** Actions the detail view cannot take itself because they open another view from the card. */
export function actionHint(action: PrimaryAction): string | null {
  switch (action) {
    case 'answer':
    case 'review_plan':
    case 'human_review':
      return `Close this window and use the card's “${ACTION_LABELS[action]}” button.`;
    default:
      return null;
  }
}

export type DetailTab = 'plan' | 'subtasks' | 'review' | 'runs';

/** The tab to open on: subtasks once there are any, else the plan once written, else the runs. */
export function defaultTab(task: Task): DetailTab {
  if ((task.subtasks ?? []).length > 0) return 'subtasks';
  if (task.planning.plan) return 'plan';
  return 'runs';
}

export function formatTime(ms: number | null | undefined): string {
  if (!ms) return '';
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
