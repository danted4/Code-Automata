import { describe, expect, it } from 'vitest';
import type { Run } from '@/lib/api/types/Run';
import type { Subtask } from '@/lib/api/types/Subtask';
import type { Task } from '@/lib/api/types/Task';
import {
  ACTION_LABELS,
  agentLines,
  primaryAction,
  progress,
  rateLimitText,
  repoChips,
  reworkLabel,
  statusBadge,
  taskStatus,
} from './task-view';

function task(over: Partial<Task> = {}): Task {
  return {
    schema: 1,
    id: 'task-1',
    title: 'T',
    createdAt: 0,
    updatedAt: 0,
    phase: 'planning',
    agents: {
      planning: { provider: 'claude' },
      dev: { provider: 'claude' },
      qa: { provider: 'claude' },
    },
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

  it('shows a rate-limited run with its reset and a Resume now', () => {
    const t = task({ phase: 'in_progress', subtasks: [sub({})] });
    const limited = taskStatus({
      ...t,
      run: run({
        state: 'rate_limited',
        resetsAt: 1_764_359_100,
        error: 'Claude Code hit its usage limit',
      }),
    });
    expect(limited).toEqual({
      kind: 'rate_limited',
      resumesAt: 1_764_359_100_000,
      estimated: false,
      error: 'Claude Code hit its usage limit',
    });
    expect(primaryAction(limited)).toBe('resume_now');
    expect(ACTION_LABELS.resume_now).toBe('Resume now');
    expect(statusBadge(limited).label).toBe('Rate-limited');
  });

  it('says when a rate-limited task resumes, naming the day when it is not today', () => {
    const now = new Date(2026, 10, 28, 14, 0).getTime();
    const later = new Date(2026, 10, 28, 15, 45).getTime();
    expect(rateLimitText(later, false, now)).toMatch(/^Resumes at .*45/);
    expect(rateLimitText(later, true, now)).toMatch(/^Retrying at /);
    const monday = new Date(2026, 10, 30, 0, 0).getTime();
    const text = rateLimitText(monday, false, now);
    expect(text).not.toBe(rateLimitText(new Date(2026, 10, 28, 0, 0).getTime(), false, now));
    expect(text).toMatch(/Mon/);
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

describe('repoChips', () => {
  const ws = (over: Partial<Task>): Task => ({
    schema: 2,
    id: 't',
    title: 't',
    createdAt: 0,
    updatedAt: 0,
    phase: 'in_progress',
    agents: { planning: { provider: 'mock' }, dev: { provider: 'mock' }, qa: { provider: 'mock' } },
    requirePlanApproval: false,
    planning: { stage: 'approved' },
    baseCommits: { api: 'a0', web: 'w0', docs: 'd0' },
    ...over,
  });
  const dev = (repos: string[], checkpoints: Record<string, string> = {}) => ({
    id: `d-${repos.join()}`,
    kind: 'dev' as const,
    title: 'x',
    detail: 'x',
    status: (Object.keys(checkpoints).length ? 'done' : 'pending') as 'done' | 'pending',
    repos,
    checkpoints,
  });

  it('shows the planned repositories, then the changed ones', () => {
    expect(repoChips(ws({}))).toEqual([]);
    expect(repoChips(ws({ subtasks: [dev(['web']), dev(['api', 'web'])] }))).toEqual([
      'api',
      'web',
    ]);
    expect(repoChips(ws({ subtasks: [dev(['web'], { docs: 'd1' }), dev(['api'])] }))).toEqual([
      'docs',
    ]);
  });

  it('shows nothing for a one-repository project', () => {
    expect(repoChips(ws({ baseCommits: { '.': 'b' } }))).toEqual([]);
  });
});

describe('agentLines', () => {
  it('is one line when every phase has the same agent, else one per phase', () => {
    expect(agentLines(task())).toEqual([{ phase: null, text: 'Claude Code' }]);
    const t = task({
      agents: {
        planning: { provider: 'claude', model: 'claude-fable-5-2' },
        dev: { provider: 'codex', model: 'gpt-6.2-sol', mode: 'high' },
        qa: { provider: 'claude', model: 'claude-fable-5-2' },
      },
    });
    expect(agentLines(t)).toEqual([
      { phase: 'Planning', text: 'Claude Code · claude-fable-5-2' },
      { phase: 'Development', text: 'Codex · gpt-6.2-sol · high' },
      { phase: 'QA', text: 'Claude Code · claude-fable-5-2' },
    ]);
  });
});
