/**
 * What the human reviewer sees for a task in Human Review, derived from the task file alone:
 * what was built, the automated checks, the QA verdicts, and what still needs a look.
 */

import type { Checks } from '@/lib/api/types/Checks';
import type { Subtask } from '@/lib/api/types/Subtask';
import type { Task } from '@/lib/api/types/Task';

/** One QA subtask with its verdict (null when it did not finish, e.g. skipped). */
export type QaEntry = { subtask: Subtask; verdict: Subtask['verdict'] };

/** Feedback the engine left when it hit the rework limit with findings unresolved. */
export type Unresolved = { feedback: string; reworkCount: number; heading: string };

export type ReviewSummary = {
  /** Finished dev subtasks, in execution order. */
  built: Subtask[];
  /** Dev subtasks that were skipped (by the engine, with a reason, or by the user). */
  skipped: Subtask[];
  checks: Checks | null;
  /** True when the checks ran against an older commit than the last dev checkpoint. */
  checksStale: boolean;
  qa: QaEntry[];
  unresolved: Unresolved | null;
  /** Short lines naming what the reviewer should look at first. Empty when all is green. */
  attention: string[];
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "Unresolved after N rework rounds". */
export function unresolvedHeading(reworkCount: number): string {
  return `Unresolved after ${plural(reworkCount, 'rework round')}`;
}

/**
 * The commit the checks should have run against: the last dev checkpoint, else the commit the
 * branch started from (as the engine decides it).
 */
export function lastDevCheckpoint(task: Task): string | null {
  const devs = (task.subtasks ?? []).filter((s) => s.kind === 'dev' && s.checkpoint);
  return devs.length ? (devs[devs.length - 1].checkpoint ?? null) : (task.baseCommit ?? null);
}

/** The engine starts its feedback with the same heading the modal shows; drop it there. */
function feedbackBody(feedback: string): string {
  return feedback.replace(/^Unresolved after \d+ rework round\(s\):\s*/, '').trim();
}

export function reviewSummary(task: Task): ReviewSummary {
  const subtasks = task.subtasks ?? [];
  const devs = subtasks.filter((s) => s.kind === 'dev');
  const built = devs.filter((s) => s.status === 'done');
  const skipped = devs.filter((s) => s.status === 'skipped');
  const qa = subtasks
    .filter((s) => s.kind === 'qa')
    .map((subtask) => ({ subtask, verdict: subtask.verdict ?? null }));

  const checks = task.review?.checks ?? null;
  const last = lastDevCheckpoint(task);
  const checksStale = !!checks && !!last && checks.commit !== last;

  const feedback = task.review?.feedback?.trim();
  const reworkCount = task.review?.reworkCount ?? 0;
  const unresolved = feedback
    ? {
        feedback: feedbackBody(feedback) || feedback,
        reworkCount,
        heading: unresolvedHeading(reworkCount),
      }
    : null;

  const attention: string[] = [];
  if (unresolved) attention.push(unresolved.heading);
  if (!checks) attention.push('The automated checks did not run');
  else if (!checks.passed) attention.push('The automated checks failed');
  else if (checksStale) attention.push('The checks ran against an older commit');
  const failedQa = qa.filter((q) => q.verdict && !q.verdict.passed).length;
  if (failedQa) attention.push(`${plural(failedQa, 'QA review')} found problems`);
  const skippedQa = qa.filter((q) => !q.verdict && q.subtask.status === 'skipped').length;
  if (skippedQa) attention.push(`${plural(skippedQa, 'QA review')} skipped`);
  const unreviewed = qa.filter((q) => !q.verdict && q.subtask.status !== 'skipped').length;
  if (unreviewed) attention.push(`${plural(unreviewed, 'QA review')} did not finish`);
  if (skipped.length) attention.push(`${plural(skipped.length, 'dev subtask')} skipped`);

  return { built, skipped, checks, checksStale, qa, unresolved, attention };
}

/** The pull request section: open a PR, push new work to the open one, or nothing to do. */
export type PullRequestAction = {
  kind: 'create' | 'update' | 'current';
  url: string | null;
  label: string;
  busyLabel: string;
  help: string;
  progress: string;
  done: string;
};

/** The newest dev checkpoint: the last work a squash puts in the pull request. */
export function newestDevCheckpoint(task: Task): string | null {
  const devs = (task.subtasks ?? []).filter((s) => s.kind === 'dev' && s.checkpoint);
  return devs.length ? (devs[devs.length - 1].checkpoint ?? null) : null;
}

/**
 * Work done after the PR was last pushed (a rework round, a retried subtask, a replan's new run)
 * ends in a different newest checkpoint than the one the PR records, and is not in the PR until it
 * is pushed again. `createdUrl` is a PR just opened here, before the task reload shows it.
 */
export function pullRequestAction(task: Task, createdUrl: string | null): PullRequestAction {
  const branch = taskBranch(task.id);
  const pr = task.pullRequest ?? null;
  const url = pr?.url ?? createdUrl;
  if (!url) {
    return {
      kind: 'create',
      url: null,
      label: 'Create pull request',
      busyLabel: 'Creating pull request…',
      help: `Squash the checkpoints into one commit, push ${branch} and open a pull request with the GitHub CLI.`,
      progress: 'Squashing, pushing and opening the pull request. This can take a minute.',
      done: 'Pull request opened',
    };
  }
  const pushed = pr ? (pr.pushedCheckpoint ?? null) : null;
  const current = pr ? pushed !== null && pushed === newestDevCheckpoint(task) : true;
  if (current) {
    return {
      kind: 'current',
      url,
      label: 'Up to date',
      busyLabel: '',
      help: 'The pull request has all of the task’s work.',
      progress: '',
      done: '',
    };
  }
  return {
    kind: 'update',
    url,
    label: 'Update pull request',
    busyLabel: 'Updating pull request…',
    help: `Work done since the pull request was last pushed (a rework round or a new plan) is not in it yet. Updating squashes everything into its one commit, pushes ${branch} and refreshes the description.`,
    progress: 'Squashing and pushing to the pull request. This can take a minute.',
    done: 'Pull request updated',
  };
}

/** The task's branch. */
export function taskBranch(taskId: string): string {
  return `code-automata/${taskId}`;
}

/** `<project root>/.code-automata/worktrees/<task id>`, or null without a project. */
export function worktreePath(
  projectRoot: string | null | undefined,
  taskId: string
): string | null {
  if (!projectRoot) return null;
  const root = projectRoot.replace(/[/\\]+$/, '');
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return [root, '.code-automata', 'worktrees', taskId].join(sep);
}
