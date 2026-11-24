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

/** Only a worktree with no task file can be deleted on its own; a task's goes with the task. */
export function canDeleteWorktree(w: Pick<WorktreeEntry, 'orphan'>): boolean {
  return w.orphan;
}

export function orphans<T extends Pick<WorktreeEntry, 'orphan'>>(list: T[]): T[] {
  return list.filter(canDeleteWorktree);
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
