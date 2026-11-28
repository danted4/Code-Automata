/**
 * What the UI shows for a task, derived from the task file alone: the badge, the buttons, the
 * progress. Components render these; they do not reason about run states themselves.
 */

import type { Phase } from '@/lib/api/types/Phase';
import type { Subtask } from '@/lib/api/types/Subtask';
import type { Task } from '@/lib/api/types/Task';
import { changedRepos, isWorkspaceTask, taskRepos } from '@/lib/review-summary';

export const PHASES: Phase[] = ['planning', 'in_progress', 'ai_review', 'human_review', 'done'];

export const PHASE_LABELS: Record<Phase, string> = {
  planning: 'Planning',
  in_progress: 'In Progress',
  ai_review: 'AI Review',
  human_review: 'Human Review',
  done: 'Done',
};

/** Where the task stands, from the user's point of view. */
export type TaskStatus =
  /** An agent (or the checks) is working on it. */
  | { kind: 'working'; label: string }
  | { kind: 'paused' }
  /** The app quit or crashed mid-step. */
  | { kind: 'interrupted' }
  | { kind: 'failed'; error: string }
  /**
   * The CLI hit its usage limit; the task resumes on its own at `resumesAt` (ms). `estimated`: the
   * CLI gave no reset time, so that is a retry.
   */
  | { kind: 'rate_limited'; resumesAt: number; estimated: boolean; error: string }
  | { kind: 'needs_answers' }
  | { kind: 'needs_plan_review' }
  /** Nothing running and nothing waiting on the user: Start continues it. */
  | { kind: 'ready' }
  | { kind: 'in_review' }
  | { kind: 'done' };

/** The one action the card offers for a status. */
export type PrimaryAction =
  | 'pause'
  | 'resume'
  | 'retry'
  | 'resume_now'
  | 'answer'
  | 'review_plan'
  | 'start'
  | 'human_review'
  | null;

function current(task: Task): Subtask | undefined {
  const id = task.run?.subtaskId;
  return id ? task.subtasks?.find((s) => s.id === id) : undefined;
}

function workingLabel(task: Task): string {
  const run = task.run;
  if (!run) return 'Working';
  const sub = current(task);
  switch (run.kind) {
    case 'plan':
      if (task.planning.revision) return 'Revising the plan';
      return task.planning.stage === 'not_started' && task.requirePlanApproval
        ? 'Asking questions'
        : 'Writing the plan';
    case 'subtask_gen':
      return 'Splitting into subtasks';
    case 'checks':
      return 'Running checks';
    case 'dev':
    case 'qa':
      return sub?.progressLabel || sub?.title || (run.kind === 'dev' ? 'Developing' : 'Reviewing');
  }
}

export function taskStatus(task: Task): TaskStatus {
  const run = task.run;
  if (run) {
    switch (run.state) {
      case 'queued':
      case 'running':
        return { kind: 'working', label: workingLabel(task) };
      case 'paused':
        return { kind: 'paused' };
      case 'interrupted':
        return { kind: 'interrupted' };
      case 'failed':
        return { kind: 'failed', error: run.error || 'The step failed.' };
      case 'rate_limited':
        return {
          kind: 'rate_limited',
          resumesAt: (run.resetsAt ?? 0) * 1000,
          estimated: run.resetEstimated ?? false,
          error: run.error || 'The agent hit its usage limit.',
        };
      case 'done':
        break; // a finished run record is not left behind; treat as no run
    }
  }
  if (task.phase === 'done') return { kind: 'done' };
  if (task.phase === 'human_review') return { kind: 'in_review' };
  if (task.phase === 'planning') {
    const p = task.planning;
    if (p.stage === 'questions') return { kind: 'needs_answers' };
    const waitsForApproval = (task.requirePlanApproval || p.hold) && !p.revision;
    if (p.stage === 'plan_ready' && waitsForApproval) return { kind: 'needs_plan_review' };
  }
  return { kind: 'ready' };
}

export function primaryAction(status: TaskStatus): PrimaryAction {
  switch (status.kind) {
    case 'working':
      return 'pause';
    case 'paused':
    case 'interrupted':
      return 'resume';
    case 'failed':
      return 'retry';
    case 'rate_limited':
      return 'resume_now';
    case 'needs_answers':
      return 'answer';
    case 'needs_plan_review':
      return 'review_plan';
    case 'ready':
      return 'start';
    case 'in_review':
      return 'human_review';
    case 'done':
      return null;
  }
}

export const ACTION_LABELS: Record<Exclude<PrimaryAction, null>, string> = {
  pause: 'Pause',
  resume: 'Resume',
  retry: 'Retry',
  resume_now: 'Resume now',
  answer: 'Answer questions',
  review_plan: 'Review plan',
  start: 'Start',
  human_review: 'Review',
};

/**
 * "Reworking (n/m)" while a rework round is under way, else null. The round is
 * `review.reworkCount`, which a user's rework resets; the newest rework subtask carries the same
 * number while its round is current.
 */
export function reworkLabel(task: Task, reworkLimit: number | null): string | null {
  if (task.phase !== 'in_progress' && task.phase !== 'ai_review') return null;
  const round = task.review?.reworkCount ?? 0;
  if (round === 0) return null;
  const rework = (task.subtasks ?? []).filter((s) => typeof s.reworkRound === 'number');
  if (rework.at(-1)?.reworkRound !== round) return null;
  return reworkLimit ? `Reworking (${round}/${reworkLimit})` : `Reworking (${round})`;
}

export type Progress = { done: number; total: number };

/** Finished (done or skipped) over all subtasks of a kind. */
export function progress(task: Task, kind: 'dev' | 'qa'): Progress {
  const subs = (task.subtasks ?? []).filter((s) => s.kind === kind);
  return { done: subs.filter((s) => s.status !== 'pending').length, total: subs.length };
}

/** Whether the task has an agent or the checks working right now. */
export function isWorking(task: Task): boolean {
  return taskStatus(task).kind === 'working';
}

export const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  cursor: 'Cursor',
  amp: 'Amp',
  mock: 'Mock',
};

/**
 * "Resumes at 15:42" (or "Retrying at …" when the CLI gave no reset time); the day is named when
 * it is not today.
 */
export function rateLimitText(resumesAt: number, estimated: boolean, now = Date.now()): string {
  const at = new Date(resumesAt);
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const today = new Date(now).toDateString() === at.toDateString();
  const when = today ? time : `${at.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return `${estimated ? 'Retrying' : 'Resumes'} at ${when}`;
}

/** The status badge's text and color, the same on the card and in the detail view. */
export function statusBadge(status: TaskStatus): { label: string; bg: string } {
  switch (status.kind) {
    case 'working':
      return { label: 'Running', bg: 'var(--color-status-in-progress)' };
    case 'paused':
      return { label: 'Paused', bg: 'var(--color-warning)' };
    case 'interrupted':
      return { label: 'Interrupted', bg: 'var(--color-warning)' };
    case 'failed':
      return { label: 'Failed', bg: 'var(--color-status-blocked)' };
    case 'rate_limited':
      return { label: 'Rate-limited', bg: 'var(--color-warning)' };
    case 'needs_answers':
      return { label: 'Questions', bg: 'var(--color-info)' };
    case 'needs_plan_review':
      return { label: 'Plan ready', bg: 'var(--color-info)' };
    case 'ready':
      return { label: 'Ready', bg: 'var(--color-status-pending)' };
    case 'in_review':
      return { label: 'Review', bg: 'var(--color-info)' };
    case 'done':
      return { label: 'Done', bg: 'var(--color-status-completed)' };
  }
}

/**
 * The repository chips on a workspace task's card: the repositories its work changed once there
 * are any, else the ones the plan named for its subtasks. None for a one-repository project.
 */
export function repoChips(task: Task): string[] {
  if (!isWorkspaceTask(task)) return [];
  const repos = taskRepos(task);
  const changed = changedRepos(task);
  if (changed.length) return changed;
  const planned = new Set((task.subtasks ?? []).flatMap((s) => s.repos ?? []));
  return repos.filter((r) => planned.has(r)).sort();
}
