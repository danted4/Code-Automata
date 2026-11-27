/**
 * What the human reviewer sees for a task in Human Review, derived from the task file alone:
 * what was built, the automated checks, the QA verdicts, and what still needs a look.
 */

import type { Checks } from '@/lib/api/types/Checks';
import type { PrHost } from '@/lib/api/types/PrHost';
import type { PullRequest } from '@/lib/api/types/PullRequest';
import type { PullRequestResponse } from '@/lib/api/types/PullRequestResponse';
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

/** The project itself as a task's repository, in a project that is one repository. */
export const ROOT_REPO = '.';

/** Whether the task's worktrees exist (they are made when planning starts). */
export function hasWorktrees(task: Task): boolean {
  return Object.keys(task.baseCommits ?? {}).length > 0;
}

/** The task's repositories, in name order (`.` for a one-repository project). */
export function taskRepos(task: Task): string[] {
  return Object.keys(task.baseCommits ?? {}).sort();
}

/** The repository the single-repository views show: the project itself, else the first. */
export function primaryRepo(task: Task): string {
  const repos = taskRepos(task);
  return repos.includes(ROOT_REPO) || repos.length === 0 ? ROOT_REPO : repos[0];
}

/** The newest dev checkpoint in `repo`: the last work a squash puts in its pull request. */
export function newestDevCheckpoint(task: Task, repo: string = primaryRepo(task)): string | null {
  const devs = (task.subtasks ?? []).filter((s) => s.kind === 'dev' && s.checkpoints?.[repo]);
  return devs.length ? (devs[devs.length - 1].checkpoints?.[repo] ?? null) : null;
}

/** The repositories some dev subtask changed (last checkpoint is not the base), as the engine. */
export function changedRepos(task: Task): string[] {
  return taskRepos(task).filter((repo) => {
    const newest = newestDevCheckpoint(task, repo);
    return newest !== null && newest !== task.baseCommits?.[repo];
  });
}

/** The repositories whose checks count: the project itself, or in a workspace the changed ones. */
export function reposToCheck(task: Task): string[] {
  const repos = taskRepos(task);
  return repos.length === 0 || repos.includes(ROOT_REPO) ? [ROOT_REPO] : changedRepos(task);
}

/**
 * The commit `repo`'s checks should have run against: its last dev checkpoint, else the commit
 * its branch started from (as the engine decides it).
 */
export function lastDevCheckpoint(task: Task, repo: string = primaryRepo(task)): string | null {
  return newestDevCheckpoint(task, repo) ?? task.baseCommits?.[repo] ?? null;
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

  // Every repository whose checks count; shown is the first that failed, else the first.
  const counted = reposToCheck(task);
  const all = task.review?.checks ?? {};
  const isStale = (repo: string) => {
    const c = all[repo];
    const last = lastDevCheckpoint(task, repo);
    return !!c && !!last && c.commit !== last;
  };
  const missingIn = counted.filter((r) => !all[r]);
  const failedIn = counted.filter((r) => all[r] && !all[r].passed);
  const staleIn = counted.filter((r) => all[r]?.passed && isStale(r));
  const shown = failedIn[0] ?? counted.find((r) => all[r]) ?? primaryRepo(task);
  const checks = all[shown] ?? null;
  const checksStale = isStale(shown) || staleIn.length > 0;
  const where = (repos: string[]) =>
    repos.length && !repos.includes(ROOT_REPO) ? ` in ${repos.join(', ')}` : '';

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
  if (failedIn.length) attention.push(`The automated checks failed${where(failedIn)}`);
  if (missingIn.length) attention.push(`The automated checks did not run${where(missingIn)}`);
  if (!failedIn.length && staleIn.length) {
    attention.push(`The checks ran against an older commit${where(staleIn)}`);
  }
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
  /** The link's text: the request itself, or on another host its page for opening one. */
  linkLabel: string;
  /** Said when the branch is pushed but the host printed no link. */
  pushedNote: string | null;
  label: string;
  busyLabel: string;
  help: string;
  progress: string;
  done: string;
};

function linkLabel(host: PrHost): string {
  switch (host) {
    case 'github':
      return 'Open pull request';
    case 'gitlab':
      return 'Open merge request';
    case 'other':
      return 'Open the pull request page';
  }
}

/**
 * Work done after the PR was last pushed (a rework round, a retried subtask, a replan's new run)
 * ends in a different newest checkpoint than the one the PR records, and is not in the PR until it
 * is pushed again. `created` is a PR just opened here, before the task reload shows it. A task
 * whose host printed no link still has a record (the branch is pushed), so it is updated, not
 * created again.
 */
export function pullRequestAction(
  task: Task,
  created: PullRequestResponse | null
): PullRequestAction {
  const branch = taskBranch(task.id);
  // In a workspace the record shown is the first changed repository's that has one. Repositories
  // with no record (never opened, or no remote, which leaves none) are left out of "up to date".
  const workspace = !taskRepos(task).includes(ROOT_REPO) && taskRepos(task).length > 0;
  const recorded = workspace
    ? changedRepos(task).filter((r) => task.pullRequests?.[r])
    : [primaryRepo(task)].filter((r) => task.pullRequests?.[r]);
  const pr = recorded.length ? (task.pullRequests?.[recorded[0]] ?? null) : null;
  if (!pr && !created) {
    return {
      kind: 'create',
      url: null,
      linkLabel: '',
      pushedNote: null,
      label: 'Create pull request',
      busyLabel: 'Creating pull request…',
      help: `Squash the checkpoints into one commit, push ${branch} and open a pull request: on GitHub with the GitHub CLI, on GitLab with git push options. On other hosts the branch is pushed and the host's link for opening one is kept.`,
      progress: 'Squashing, pushing and opening the pull request. This can take a minute.',
      done: 'Pull request opened',
    };
  }
  const url = pr?.url ?? created?.url ?? null;
  // Records from before 3.0.1 have no host; they were all GitHub.
  const host = pr?.host ?? created?.host ?? 'github';
  const link = {
    url,
    linkLabel: url ? linkLabel(host) : '',
    pushedNote: url ? null : `${branch} is pushed. Open the pull request on your host.`,
  };
  const upToDate = (repo: string) => {
    const record = task.pullRequests?.[repo];
    const pushed = record?.pushedCheckpoint ?? null;
    return pushed !== null && pushed === newestDevCheckpoint(task, repo);
  };
  const current = pr ? recorded.every(upToDate) : true;
  const noun = requestNoun(host);
  if (current) {
    return {
      kind: 'current',
      ...link,
      label: 'Up to date',
      busyLabel: '',
      help: noun
        ? `The ${noun} has all of the task’s work.`
        : `${branch} is pushed with all of the task’s work.${url ? ' Open the pull request on your host with the link.' : ''}`,
      progress: '',
      done: '',
    };
  }
  if (!noun) {
    return {
      kind: 'update',
      ...link,
      label: 'Push again',
      busyLabel: 'Pushing…',
      help: `Work done since ${branch} was last pushed (a rework round or a new plan) is not on it yet. Pushing again squashes everything into its one commit and pushes it; a pull request opened from the branch picks it up.`,
      progress: 'Squashing and pushing. This can take a minute.',
      done: 'Branch pushed',
    };
  }
  const Noun = capitalize(noun);
  return {
    kind: 'update',
    ...link,
    label: `Update ${noun}`,
    busyLabel: `Updating ${noun}…`,
    help: `Work done since the ${noun} was last pushed (a rework round or a new plan) is not in it yet. Updating squashes everything into its one commit, pushes ${branch} and refreshes the description.`,
    progress: `Squashing and pushing to the ${noun}. This can take a minute.`,
    done: `${Noun} updated`,
  };
}

/** What the host calls it, or null on a host where Code-Automata only pushes the branch. */
function requestNoun(host: PrHost): string | null {
  switch (host) {
    case 'github':
      return 'pull request';
    case 'gitlab':
      return 'merge request';
    case 'other':
      return null;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The toast after Create or Update, from what the server did (the host is only known then): a
 * pushed branch is never called an opened pull request, and a request is "updated" only if the
 * task already had one on the same host (a pushed branch that now gets a GitHub PR is "opened").
 * `warn` when the server added a note.
 */
export function pullRequestToast(
  taskId: string,
  previous: PullRequest | null,
  result: PullRequestResponse
): { title: string; description: string; warn: boolean } {
  const noun = requestNoun(result.host);
  const wasOpen =
    previous !== null && previous.url !== null && (previous.host ?? 'github') === result.host;
  const title = noun ? `${capitalize(noun)} ${wasOpen ? 'updated' : 'opened'}` : 'Branch pushed';
  const description =
    result.note ??
    result.url ??
    `${taskBranch(taskId)} is pushed; open the pull request on your host`;
  return { title, description, warn: result.note !== null };
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
