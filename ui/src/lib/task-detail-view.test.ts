import { describe, expect, it } from 'vitest';
import type { Run } from '@/lib/api/types/Run';
import type { Subtask } from '@/lib/api/types/Subtask';
import type { Task } from '@/lib/api/types/Task';
import {
  actionHint,
  changedFileRow,
  changesSummary,
  defaultTab,
  shortSha,
  subtaskRows,
} from './task-detail-view';

function sub(over: Partial<Subtask>): Subtask {
  return { id: 'dev-1', kind: 'dev', title: 'S', detail: '', status: 'pending', ...over };
}

function task(over: Partial<Task> = {}): Task {
  return {
    schema: 1,
    id: 'task-1',
    title: 'T',
    createdAt: 0,
    updatedAt: 0,
    phase: 'in_progress',
    agent: { provider: 'claude' },
    requirePlanApproval: false,
    planning: { stage: 'approved', plan: '# Plan' },
    ...over,
  };
}

const run = (over: Partial<Run>): Run => ({
  id: 'run-1',
  kind: 'dev',
  state: 'running',
  subtaskId: 'dev-2',
  attempt: 1,
  startedAt: 0,
  updatedAt: 0,
  ...over,
});

describe('subtaskRows', () => {
  const subtasks = [
    sub({ id: 'qa-1', kind: 'qa' }),
    sub({ id: 'dev-1', status: 'done' }),
    sub({ id: 'dev-2' }),
    sub({ id: 'dev-3', status: 'skipped' }),
  ];

  it('splits dev and QA in order and marks the running one', () => {
    const rows = subtaskRows(task({ subtasks, run: run({}) }));
    expect(rows.dev.map((r) => r.subtask.id)).toEqual(['dev-1', 'dev-2', 'dev-3']);
    expect(rows.qa.map((r) => r.subtask.id)).toEqual(['qa-1']);
    expect(rows.dev.map((r) => r.running)).toEqual([false, true, false]);
    // Nothing can be skipped while a step runs (the server says to pause first).
    expect(rows.dev.map((r) => r.canSkip)).toEqual([false, false, false]);
  });

  it('keeps a halted step current but not running', () => {
    const rows = subtaskRows(task({ subtasks, run: run({ state: 'paused' }) }));
    expect(rows.dev[1]).toMatchObject({ running: false, current: true, canSkip: true });
  });

  it('handles a task without subtasks', () => {
    expect(subtaskRows(task())).toEqual({ dev: [], qa: [] });
  });
});

describe('small helpers', () => {
  it('shortens shas', () => {
    expect(shortSha('0123456789abcdef')).toBe('0123456');
    expect(shortSha(null)).toBe('');
  });

  it('hints for actions that open another view', () => {
    expect(actionHint('answer')).toContain('Answer questions');
    expect(actionHint('human_review')).toContain('Review');
    expect(actionHint('pause')).toBeNull();
    expect(actionHint(null)).toBeNull();
  });

  it('opens on the most useful tab', () => {
    expect(defaultTab(task({ subtasks: [sub({})] }))).toBe('subtasks');
    expect(defaultTab(task())).toBe('plan');
    expect(defaultTab(task({ planning: { stage: 'not_started' } }))).toBe('runs');
  });
});

describe('changes', () => {
  it('marks each file and sums the lines', () => {
    expect(changedFileRow({ path: 'a.ts', status: 'modified', added: 3, deleted: 1 })).toEqual({
      mark: 'M',
      path: 'a.ts',
      lines: '+3 −1',
    });
    expect(
      changedFileRow({ path: 'img.png', status: 'added', added: null, deleted: null })
    ).toEqual({
      mark: 'A',
      path: 'img.png',
      lines: '',
    });
    expect(
      changesSummary({
        repo: 'api',
        total: 2,
        files: [
          { path: 'a', status: 'added', added: 4, deleted: 0 },
          { path: 'b', status: 'deleted', added: 0, deleted: 2 },
        ],
      })
    ).toBe('2 files changed, +4 −2');
    expect(changesSummary({ repo: '.', total: 1, files: [] })).toBe('1 file changed');
  });
});
