import { describe, expect, it } from 'vitest';
import type { Subtask } from '@/lib/api/types/Subtask';
import type { Task } from '@/lib/api/types/Task';
import {
  lastDevCheckpoint,
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
