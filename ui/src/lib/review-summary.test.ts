import { describe, expect, it } from 'vitest';
import type { Subtask } from '@/lib/api/types/Subtask';
import type { Task } from '@/lib/api/types/Task';
import {
  lastDevCheckpoint,
  pullRequestAction,
  reviewSummary,
  taskBranch,
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
        sub({ id: 'dev-1', checkpoint: 'c1', handoff: 'Added the parser' }),
        sub({ id: 'dev-2', checkpoint: 'c2' }),
        sub({ id: 'qa-1', kind: 'qa', verdict: { passed: true, summary: 'Looks right' } }),
      ],
      review: { reworkCount: 0, checks: passed },
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
        sub({ id: 'dev-1', checkpoint: 'c2' }),
        sub({ id: 'dev-2', status: 'skipped', skippedReason: 'not needed' }),
        sub({
          id: 'qa-1',
          kind: 'qa',
          verdict: { passed: false, summary: 'Bug', findings: ['x'] },
        }),
        sub({ id: 'qa-2', kind: 'qa', status: 'skipped', skippedReason: 'not run' }),
        sub({ id: 'qa-3', kind: 'qa', status: 'pending' }),
      ],
      review: { reworkCount: 0, checks: { ...passed, passed: false } },
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
    const subtasks = [sub({ checkpoint: 'c3' })];
    expect(reviewSummary(task({ subtasks })).attention).toEqual([
      'The automated checks did not run',
    ]);
    const stale = reviewSummary(task({ subtasks, review: { reworkCount: 0, checks: passed } }));
    expect(stale.checksStale).toBe(true);
    expect(stale.attention).toEqual(['The checks ran against an older commit']);
  });

  it('reports unresolved feedback without repeating the engine heading', () => {
    const t = task({
      subtasks: [sub({ checkpoint: 'c2' })],
      review: {
        reworkCount: 2,
        checks: passed,
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

  it('falls back to the base commit when no dev subtask has a checkpoint', () => {
    expect(lastDevCheckpoint(task({ baseCommit: 'b0' }))).toBe('b0');
    expect(lastDevCheckpoint(task())).toBeNull();
    const t = task({ baseCommit: 'b0', subtasks: [sub({ checkpoint: 'c1' }), sub({})] });
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
      checkpoint,
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
      pullRequest: { url, pushedCheckpoint: 'a2' },
    });
    const a = pullRequestAction(t, null);
    expect(a.kind).toBe('current');
    expect(a.url).toBe(url);
    expect(a.label).toBe('Up to date');
  });

  it('offers the update after a rework round added a checkpoint', () => {
    const t = task({
      subtasks: [dev('d1', 'a1'), dev('d2', 'a2'), dev('rework-1', 'a3')],
      pullRequest: { url, pushedCheckpoint: 'a2' },
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
      pullRequest: { url, pushedCheckpoint: 'a2' },
    });
    expect(pullRequestAction(t, null).kind).toBe('update');
  });

  it('offers the update for a PR recorded before checkpoints were', () => {
    const t = task({ subtasks: [dev('d1', 'a1')], pullRequest: { url } });
    expect(pullRequestAction(t, null).kind).toBe('update');
  });

  it('counts a PR just opened here as up to date until the task reloads', () => {
    const a = pullRequestAction(task({ subtasks: [dev('d1', 'a1')] }), { url, host: 'github' });
    expect(a.kind).toBe('current');
    expect(a.linkLabel).toBe('Open pull request');
  });

  it('names the link after the host', () => {
    const at = (host: 'github' | 'gitlab' | 'other') =>
      pullRequestAction(
        task({ subtasks: [dev('d1', 'a1')], pullRequest: { url, host, pushedCheckpoint: 'a1' } }),
        null
      ).linkLabel;
    expect(at('github')).toBe('Open pull request');
    expect(at('gitlab')).toBe('Open merge request');
    expect(at('other')).toBe('Open the pull request page');
    // Before 3.0.1 there was no host: GitHub.
    const old = task({ subtasks: [dev('d1', 'a1')], pullRequest: { url, pushedCheckpoint: 'a1' } });
    expect(pullRequestAction(old, null).linkLabel).toBe('Open pull request');
  });

  it('updates a pushed branch whose host printed no link, and says so', () => {
    const t = task({
      subtasks: [dev('d1', 'a1'), dev('rework-1', 'a2')],
      pullRequest: { url: null, host: 'other', pushedCheckpoint: 'a1' },
    });
    const a = pullRequestAction(t, null);
    expect(a.kind).toBe('update');
    expect(a.url).toBeNull();
    expect(a.pushedNote).toContain(taskBranch(t.id));
    // Just pushed here, before the reload: up to date, not "create" again.
    const fresh = pullRequestAction(task({ subtasks: [dev('d1', 'a1')] }), {
      url: null,
      host: 'other',
    });
    expect(fresh.kind).toBe('current');
    expect(fresh.pushedNote).not.toBeNull();
  });
});
