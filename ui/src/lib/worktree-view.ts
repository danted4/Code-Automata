/**
 * Pure helpers for the worktrees page: labels and sizes.
 */

import type { WorktreeEntry } from '@/lib/api/types/WorktreeEntry';

/** Bytes as B, KB, MB or GB (1024-based), one decimal at most. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${Number((bytes / 1024 ** i).toFixed(1))} ${units[i]}`;
}

/** The card's heading: the task title, or why there is none. */
export function worktreeTitle(w: Pick<WorktreeEntry, 'taskTitle' | 'orphan'>): string {
  if (w.taskTitle !== null) return w.taskTitle;
  return w.orphan ? 'Orphan (task deleted)' : 'Task file unreadable';
}

/**
 * A worktree can be removed on its own when its task file is gone (an orphan: folder and branch
 * go) or its task is done (folder only: the task and branch stay, and reopening the task brings
 * the worktree back). Any other task's worktree goes with the task.
 */
export function canDeleteWorktree(w: Pick<WorktreeEntry, 'orphan' | 'taskDone'>): boolean {
  return w.orphan || w.taskDone;
}

/** The card's note under the size, and its button label when it has one. */
export function worktreeAction(w: Pick<WorktreeEntry, 'orphan' | 'taskDone'>): {
  note: string | null;
  button: string | null;
} {
  if (w.orphan) return { note: null, button: 'Delete' };
  if (w.taskDone) {
    return {
      note: 'The task is done. Remove its worktree to free the space; reopening the task brings it back.',
      button: 'Remove worktree',
    };
  }
  return {
    note: 'This is a task’s worktree. You can remove it once the task is done.',
    button: null,
  };
}

/** The confirm dialog's words for removing these worktrees. */
export function deleteDialogText(list: Pick<WorktreeEntry, 'orphan' | 'taskDone'>[]): {
  title: string;
  description: string;
  confirm: string;
} {
  const single = list.length === 1;
  if (single && list[0].taskDone && !list[0].orphan) {
    return {
      title: 'Remove worktree',
      description:
        'The task is done. This removes its worktree folder to free the space. The task and its branch stay, and reopening the task brings the worktree back.',
      confirm: 'Remove',
    };
  }
  return {
    title: single ? 'Delete orphan worktree' : `Delete ${list.length} orphan worktrees`,
    description: `${single ? 'Its task no longer exists.' : 'Their tasks no longer exist.'} This removes the worktree folder and its local branch. It cannot be undone.`,
    confirm: 'Delete',
  };
}

/** The worktrees "Clean up orphans" removes: only those with no task file (never a done task's). */
export function orphans<T extends Pick<WorktreeEntry, 'orphan'>>(list: T[]): T[] {
  return list.filter((w) => w.orphan);
}

/** "Clean", "Uncommitted changes" or "Unknown" when the server could not tell. */
export function dirtyLabel(isDirty: boolean | null): string {
  if (isDirty === null) return 'Unknown';
  return isDirty ? 'Uncommitted changes' : 'Clean';
}

/** "Removed 2 orphan worktrees", with failures when some could not be removed. */
export function cleanupSummary(removed: number, failed: number): string {
  const noun = (n: number) => `orphan worktree${n === 1 ? '' : 's'}`;
  const base =
    removed === 0 ? 'No orphan worktrees removed' : `Removed ${removed} ${noun(removed)}`;
  return failed > 0 ? `${base}; ${failed} could not be removed` : base;
}
