import { describe, expect, it } from 'vitest';
import type { Run } from '@/lib/api/types/Run';
import type { Subtask } from '@/lib/api/types/Subtask';
import type { Task } from '@/lib/api/types/Task';
import { primaryAction, progress, reworkLabel, taskStatus } from './task-view';

function task(over: Partial<Task> = {}): Task {
  return {
    schema: 1,
    id: 'task-1',
    title: 'T',
    createdAt: 0,
    updatedAt: 0,
    phase: 'planning',
    agent: { provider: 'claude' },
    requirePlanApproval: false,
    planning: { stage: 'not_started' },
    ...over,
  };
}

function run(over: Partial<Run>): Run {
  return {
    id: 'run-1',
    kind: 'dev',
    state: 'running',
    attempt: 1,
    startedAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function sub(over: Partial<Subtask>): Subtask {
  return { id: 'dev-1', kind: 'dev', title: 'Step', detail: '', status: 'pending', ...over };
}

describe('taskStatus and primaryAction', () => {
  it('follows the run state first', () => {
    const subtasks = [sub({ progressLabel: 'Writing tests' })];
    const t = task({ phase: 'in_progress', subtasks, run: run({ subtaskId: 'dev-1' }) });
    expect(taskStatus(t)).toEqual({ kind: 'working', label: 'Writing tests' });
    expect(primaryAction(taskStatus(t))).toBe('pause');
    expect(primaryAction(taskStatus({ ...t, run: run({ state: 'paused' }) }))).toBe('resume');
    expect(primaryAction(taskStatus({ ...t, run: run({ state: 'interrupted' }) }))).toBe('resume');
    const failed = taskStatus({ ...t, run: run({ state: 'failed', error: 'boom' }) });
    expect(failed).toEqual({ kind: 'failed', error: 'boom' });
    expect(primaryAction(failed)).toBe('retry');
  });

  it('names the planning step that is running', () => {
    const planning = (over: Partial<Task>) =>
      taskStatus(task({ run: run({ kind: 'plan', subtaskId: null }), ...over }));
    expect(planning({ requirePlanApproval: true })).toEqual({
      kind: 'working',
      label: 'Asking questions',
    });
    expect(planning({})).toEqual({ kind: 'working', label: 'Writing the plan' });
    expect(planning({ planning: { stage: 'plan_ready', plan: 'p', revision: 'shorter' } })).toEqual(
      { kind: 'working', label: 'Revising the plan' }
    );
  });

  it('treats a revision with no run as ready, so Start can continue it', () => {
    const t = task({ planning: { stage: 'plan_ready', plan: 'p', revision: 'shorter' } });
    expect(taskStatus(t).kind).toBe('ready');
    expect(primaryAction(taskStatus(t))).toBe('start');
  });

  it('waits on the user for questions and for plan approval', () => {
    expect(taskStatus(task({ planning: { stage: 'questions' } })).kind).toBe('needs_answers');
    const ready = { stage: 'plan_ready' as const, plan: 'p' };
    expect(taskStatus(task({ requirePlanApproval: true, planning: ready })).kind).toBe(
      'needs_plan_review'
    );
    expect(taskStatus(task({ planning: { ...ready, hold: true } })).kind).toBe('needs_plan_review');
    // Without approval the engine approves on its own when started.
    expect(taskStatus(task({ planning: ready })).kind).toBe('ready');
    expect(primaryAction(taskStatus(task()))).toBe('start');
  });

  it('ends in review and done', () => {
    expect(primaryAction(taskStatus(task({ phase: 'human_review' })))).toBe('human_review');
    expect(primaryAction(taskStatus(task({ phase: 'done' })))).toBeNull();
  });
});

describe('reworkLabel and progress', () => {
  it('shows the current rework round against the limit', () => {
    const subtasks = [
      sub({}),
      sub({ id: 'rework-1', reworkRound: 1, status: 'done' }),
      sub({ id: 'rework-2', reworkRound: 2 }),
    ];
    const review = (reworkCount: number) => ({ reworkCount });
    const t = (over: Partial<Task>) => task({ phase: 'in_progress', subtasks, ...over });
    expect(reworkLabel(t({ review: review(2) }), 2)).toBe('Reworking (2/2)');
    expect(reworkLabel(t({ review: review(2) }), null)).toBe('Reworking (2)');
    expect(reworkLabel(t({ phase: 'human_review', review: review(2) }), 2)).toBeNull();
    expect(reworkLabel(task({ phase: 'in_progress', subtasks: [sub({})] }), 2)).toBeNull();
    // A user's rework resets the count: after AI rounds 1 and 2, the user's round is round 1.
    const afterUser = [...subtasks, sub({ id: 'rework-1-2', reworkRound: 1 })];
    expect(reworkLabel(t({ subtasks: afterUser, review: review(1) }), 2)).toBe('Reworking (1/2)');
    // Moved back by hand with no new rework subtask: not reworking.
    expect(reworkLabel(t({ subtasks, review: review(1) }), 2)).toBeNull();
  });

  it('counts skipped subtasks as finished', () => {
    const subtasks = [
      sub({ status: 'done' }),
      sub({ id: 'dev-2', status: 'skipped' }),
      sub({ id: 'dev-3' }),
      sub({ id: 'qa-1', kind: 'qa' }),
    ];
    expect(progress(task({ subtasks }), 'dev')).toEqual({ done: 2, total: 3 });
    expect(progress(task({ subtasks }), 'qa')).toEqual({ done: 0, total: 1 });
  });
});
