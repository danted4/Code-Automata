import { describe, expect, it } from 'vitest';
import type { Subtask } from '@/lib/api/types/Subtask';
import type { Task } from '@/lib/api/types/Task';
import {
  hasWorktrees,
  lastDevCheckpoint,
  primaryRepo,
  pullRequestAction,
  pullRequestToast,
  reviewSummary,
  taskBranch,
  taskRepos,
  unresolvedHeading,
  worktreePath,
} from './review-summary';

function task(over: Partial<Task> = {}): Task {
  return {
    schema: 1,
    id: 'task-1',
    title: 'T',
    createdAt: 0,
    updatedAt: 0,
    phase: 'human_review',
    agent: { provider: 'claude' },
    requirePlanApproval: false,
    planning: { stage: 'approved' },
    ...over,
  };
}

function sub(over: Partial<Subtask>): Subtask {
  return { id: 'dev-1', kind: 'dev', title: 'Step', detail: '', status: 'done', ...over };
}

const passed = { passed: true, summary: 'ok', at: 0, commit: 'c2' };

describe('reviewSummary', () => {
  it('is all green when checks pass on the last checkpoint and QA passed', () => {
    const t = task({
      subtasks: [
        sub({ id: 'dev-1', checkpoints: { '.': 'c1' }, handoff: 'Added the parser' }),
        sub({ id: 'dev-2', checkpoints: { '.': 'c2' } }),
        sub({ id: 'qa-1', kind: 'qa', verdict: { passed: true, summary: 'Looks right' } }),
      ],
      review: { reworkCount: 0, checks: { '.': passed } },
    });
    const s = reviewSummary(t);
    expect(s.built.map((b) => b.id)).toEqual(['dev-1', 'dev-2']);
    expect(s.skipped).toEqual([]);
    expect(s.qa.map((q) => q.verdict?.passed)).toEqual([true]);
    expect(s.checksStale).toBe(false);
    expect(s.unresolved).toBeNull();
    expect(s.attention).toEqual([]);
  });

  it('names failing checks, failed and skipped QA, and skipped dev subtasks', () => {
    const t = task({
      subtasks: [
        sub({ id: 'dev-1', checkpoints: { '.': 'c2' } }),
        sub({ id: 'dev-2', status: 'skipped', skippedReason: 'not needed' }),
        sub({
          id: 'qa-1',
          kind: 'qa',
          verdict: { passed: false, summary: 'Bug', findings: ['x'] },
        }),
        sub({ id: 'qa-2', kind: 'qa', status: 'skipped', skippedReason: 'not run' }),
        sub({ id: 'qa-3', kind: 'qa', status: 'pending' }),
      ],
      review: { reworkCount: 0, checks: { '.': { ...passed, passed: false } } },
    });
    expect(reviewSummary(t).attention).toEqual([
      'The automated checks failed',
      '1 QA review found problems',
      '1 QA review skipped',
      '1 QA review did not finish',
      '1 dev subtask skipped',
    ]);
  });

  it('flags missing and stale checks', () => {
    const subtasks = [sub({ checkpoints: { '.': 'c3' } })];
    expect(reviewSummary(task({ subtasks })).attention).toEqual([
      'The automated checks did not run',
    ]);
    const stale = reviewSummary(
      task({ subtasks, review: { reworkCount: 0, checks: { '.': passed } } })
    );
    expect(stale.checksStale).toBe(true);
    expect(stale.attention).toEqual(['The checks ran against an older commit']);
  });

  it('reports unresolved feedback without repeating the engine heading', () => {
    const t = task({
      subtasks: [sub({ checkpoints: { '.': 'c2' } })],
      review: {
        reworkCount: 2,
        checks: { '.': passed },
        feedback: 'Unresolved after 2 rework round(s):\n\nFix the login test.',
      },
    });
    const s = reviewSummary(t);
    expect(s.unresolved).toEqual({
      feedback: 'Fix the login test.',
      reworkCount: 2,
      heading: 'Unresolved after 2 rework rounds',
    });
    expect(s.attention[0]).toBe('Unresolved after 2 rework rounds');
  });
});

describe('helpers', () => {
  it('pluralizes the heading', () => {
    expect(unresolvedHeading(1)).toBe('Unresolved after 1 rework round');
    expect(unresolvedHeading(3)).toBe('Unresolved after 3 rework rounds');
  });

  it('reads each repository of a workspace task on its own', () => {
    const t = task({
      baseCommits: { web: 'w0', api: 'a0' },
      subtasks: [sub({ checkpoints: { api: 'a1' } })],
    });
    expect(taskRepos(t)).toEqual(['api', 'web']);
    expect(primaryRepo(t)).toBe('api');
    expect(lastDevCheckpoint(t, 'api')).toBe('a1');
    expect(lastDevCheckpoint(t, 'web')).toBe('w0');
    expect(hasWorktrees(t)).toBe(true);
    expect(hasWorktrees(task())).toBe(false);
  });

  it('falls back to the base commit when no dev subtask has a checkpoint', () => {
    expect(lastDevCheckpoint(task({ baseCommits: { '.': 'b0' } }))).toBe('b0');
    expect(lastDevCheckpoint(task())).toBeNull();
    const t = task({
      baseCommits: { '.': 'b0' },
      subtasks: [sub({ checkpoints: { '.': 'c1' } }), sub({})],
    });
    expect(lastDevCheckpoint(t)).toBe('c1');
  });

  it('builds the branch and worktree path', () => {
    expect(taskBranch('task-1')).toBe('code-automata/task-1');
    expect(worktreePath('/repo/', 'task-1')).toBe('/repo/.code-automata/worktrees/task-1');
    expect(worktreePath('C:\\repo', 'task-1')).toBe('C:\\repo\\.code-automata\\worktrees\\task-1');
    expect(worktreePath(null, 'task-1')).toBeNull();
  });
});

describe('pullRequestAction', () => {
  const dev = (id: string, checkpoint: string | null): Subtask =>
    ({
      id,
      kind: 'dev',
      status: checkpoint ? 'done' : 'pending',
      checkpoints: checkpoint ? { '.': checkpoint } : {},
    }) as unknown as Subtask;
  const url = 'https://github.com/o/r/pull/1';

  it('creates a pull request when there is none', () => {
    const a = pullRequestAction(task({ subtasks: [dev('d1', 'a1')] }), null);
    expect(a.kind).toBe('create');
    expect(a.label).toBe('Create pull request');
    expect(a.help).toContain(taskBranch(task().id));
  });

  it('is up to date when the PR holds the newest dev checkpoint', () => {
    const t = task({
      subtasks: [dev('d1', 'a1'), dev('d2', 'a2')],
      pullRequests: { '.': { url, pushedCheckpoint: 'a2' } },
    });
    const a = pullRequestAction(t, null);
    expect(a.kind).toBe('current');
    expect(a.url).toBe(url);
    expect(a.label).toBe('Up to date');
  });

  it('offers the update after a rework round added a checkpoint', () => {
    const t = task({
      subtasks: [dev('d1', 'a1'), dev('d2', 'a2'), dev('rework-1', 'a3')],
      pullRequests: { '.': { url, pushedCheckpoint: 'a2' } },
    });
    const a = pullRequestAction(t, null);
    expect(a.kind).toBe('update');
    expect(a.help).toMatch(/not in it yet/);
    expect(a.done).toBe('Pull request updated');
  });

  it('offers the update after a replan with as many subtasks as before', () => {
    // Same count, different work: only the checkpoint tells them apart.
    const t = task({
      subtasks: [dev('d1', 'b1'), dev('d2', 'b2')],
      pullRequests: { '.': { url, pushedCheckpoint: 'a2' } },
    });
    expect(pullRequestAction(t, null).kind).toBe('update');
  });

  it('offers the update for a PR recorded before checkpoints were', () => {
    const t = task({ subtasks: [dev('d1', 'a1')], pullRequests: { '.': { url } } });
    expect(pullRequestAction(t, null).kind).toBe('update');
  });

  it('counts a PR just opened here as up to date until the task reloads', () => {
    const a = pullRequestAction(task({ subtasks: [dev('d1', 'a1')] }), {
      url,
      host: 'github',
      note: null,
    });
    expect(a.kind).toBe('current');
    expect(a.linkLabel).toBe('Open pull request');
  });

  it('names the link after the host', () => {
    const at = (host: 'github' | 'gitlab' | 'other') =>
      pullRequestAction(
        task({
          subtasks: [dev('d1', 'a1')],
          pullRequests: { '.': { url, host, pushedCheckpoint: 'a1' } },
        }),
        null
      ).linkLabel;
    expect(at('github')).toBe('Open pull request');
    expect(at('gitlab')).toBe('Open merge request');
    expect(at('other')).toBe('Open the pull request page');
    // Before 3.0.1 there was no host: GitHub.
    const old = task({
      subtasks: [dev('d1', 'a1')],
      pullRequests: { '.': { url, pushedCheckpoint: 'a1' } },
    });
    expect(pullRequestAction(old, null).linkLabel).toBe('Open pull request');
  });

  it('never calls a pushed branch a pull request', () => {
    const at = (host: 'github' | 'gitlab' | 'other', url: string | null, newest: string) =>
      pullRequestAction(
        task({
          subtasks: [dev('d1', 'a1'), dev('d2', newest)],
          pullRequests: { '.': { url, host, pushedCheckpoint: 'a2' } },
        }),
        null
      );
    const otherCurrent = at('other', null, 'a2');
    expect(otherCurrent.help).toContain('is pushed with all');
    expect(otherCurrent.help).not.toMatch(/pull request has/);
    const otherUpdate = at('other', 'https://host/o/r/compare/x', 'a3');
    expect(otherUpdate.label).toBe('Push again');
    expect(otherUpdate.done).toBe('Branch pushed');
    expect(otherUpdate.help).not.toMatch(/^The pull request/);
    expect(at('gitlab', url, 'a3').label).toBe('Update merge request');
    expect(at('gitlab', url, 'a2').help).toBe('The merge request has all of the task’s work.');
    expect(at('github', url, 'a3').done).toBe('Pull request updated');
  });

  it('words the toast from what the server did', () => {
    expect(pullRequestToast('t', null, { url, host: 'github', note: null })).toEqual({
      title: 'Pull request opened',
      description: url,
      warn: false,
    });
    const mr = 'https://gitlab.corp/g/r/-/merge_requests/1';
    expect(
      pullRequestToast('t', { url: mr, host: 'gitlab' }, { url: mr, host: 'gitlab', note: null })
        .title
    ).toBe('Merge request updated');
    // A pre-3.0.1 record is GitHub.
    expect(pullRequestToast('t', { url }, { url, host: 'github', note: null }).title).toBe(
      'Pull request updated'
    );
    // A pushed branch that now gets a GitHub PR: opened, not updated.
    const page = 'https://github.com/o/r/pull/new/x';
    expect(
      pullRequestToast('t', { url: page, host: 'other' }, { url, host: 'github', note: null }).title
    ).toBe('Pull request opened');
    const pushed = pullRequestToast('t', null, { url: null, host: 'other', note: null });
    expect(pushed.title).toBe('Branch pushed');
    expect(pushed.description).toContain('code-automata/t');
    const noted = pullRequestToast('t', null, { url: null, host: 'other', note: 'only pushed' });
    expect(noted).toEqual({ title: 'Branch pushed', description: 'only pushed', warn: true });
  });

  it('updates a pushed branch whose host printed no link, and says so', () => {
    const t = task({
      subtasks: [dev('d1', 'a1'), dev('rework-1', 'a2')],
      pullRequests: { '.': { url: null, host: 'other', pushedCheckpoint: 'a1' } },
    });
    const a = pullRequestAction(t, null);
    expect(a.kind).toBe('update');
    expect(a.url).toBeNull();
    expect(a.pushedNote).toContain(taskBranch(t.id));
    // Just pushed here, before the reload: up to date, not "create" again.
    const fresh = pullRequestAction(task({ subtasks: [dev('d1', 'a1')] }), {
      url: null,
      host: 'other',
      note: null,
    });
    expect(fresh.kind).toBe('current');
    expect(fresh.pushedNote).not.toBeNull();
  });
});
