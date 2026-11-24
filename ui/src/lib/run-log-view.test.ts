import { describe, expect, it } from 'vitest';
import type { Outcome } from '@/lib/api/types/Outcome';
import type { Run } from '@/lib/api/types/Run';
import type { RunLogInfo } from '@/lib/api/types/RunLogInfo';
import type { RunLogLine } from '@/lib/api/types/RunLogLine';
import type { Task } from '@/lib/api/types/Task';
import {
  unseenLive,
  eventRow,
  liveRunName,
  logEnded,
  logRows,
  newestFirst,
  outcomeProblem,
  runRowState,
  runStateLabel,
  runTitle,
  summarizeInput,
} from './run-log-view';

function task(run: Partial<Run> | null): Task {
  return {
    schema: 1,
    id: 'task-1',
    title: 'T',
    createdAt: 0,
    updatedAt: 0,
    phase: 'in_progress',
    agent: { provider: 'claude' },
    requirePlanApproval: false,
    planning: { stage: 'approved' },
    subtasks: [{ id: 'dev-1', kind: 'dev', title: 'S', detail: '', status: 'pending' }],
    run: run
      ? {
          id: 'run-1',
          kind: 'dev',
          state: 'running',
          subtaskId: 'dev-1',
          attempt: 1,
          startedAt: 0,
          updatedAt: 0,
          ...run,
        }
      : null,
  };
}

function info(over: Partial<RunLogInfo>): RunLogInfo {
  return {
    name: 'run-1-1-run',
    runId: 'run-1',
    attempt: 1,
    label: 'run',
    kind: 'dev',
    subtaskId: 'dev-1',
    provider: 'claude',
    startedAt: 100,
    ...over,
  };
}

const base = { sessionId: null, finalText: '', structured: null, turns: null, costUsd: null };
const outcome = (kind: Partial<Outcome>): Outcome =>
  ({ ...base, kind: 'completed', ...kind }) as Outcome;

describe('runTitle', () => {
  it('names the kind and any label beyond run', () => {
    expect(runTitle({ kind: 'dev', label: 'run' })).toBe('Dev');
    expect(runTitle({ kind: 'dev', label: 'triage' })).toBe('Dev triage');
    expect(runTitle({ kind: 'plan', label: 'run-repair' })).toBe('Plan repair');
    expect(runTitle({ kind: 'dev', label: 'triage-repair' })).toBe('Dev triage repair');
  });
});

describe('outcomeProblem', () => {
  it('names every ending but completed', () => {
    expect(outcomeProblem(outcome({ kind: 'completed' }))).toBeNull();
    expect(outcomeProblem(outcome({ kind: 'agent_error', message: 'rate limited' }))).toBe(
      'Agent error: rate limited'
    );
    expect(outcomeProblem(outcome({ kind: 'timed_out' }))).toBe('Timed out');
    expect(outcomeProblem(outcome({ kind: 'stopped' }))).toBe('Stopped');
    expect(outcomeProblem(outcome({ kind: 'crashed', exitCode: 2 }))).toBe('Crashed (exit code 2)');
    expect(outcomeProblem(outcome({ kind: 'crashed', exitCode: null }))).toBe('Crashed');
  });
});

describe('liveRunName and runRowState', () => {
  const runs = [
    info({ name: 'a', label: 'triage', startedAt: 100, outcome: outcome({ kind: 'completed' }) }),
    info({ name: 'b', startedAt: 200 }),
  ];

  it('is the newest log of the working run and attempt', () => {
    const live = liveRunName(runs, task({}));
    expect(live).toBe('b');
    expect(runRowState(runs[0], live)).toEqual({ kind: 'completed' });
    expect(runRowState(runs[1], live)).toEqual({ kind: 'running' });
  });

  it('is nothing when the task is not working', () => {
    expect(liveRunName(runs, task({ state: 'interrupted' }))).toBeNull();
    expect(liveRunName(runs, task(null))).toBeNull();
    expect(liveRunName(runs, undefined)).toBeNull();
    expect(runStateLabel(runRowState(runs[1], null))).toBe(
      'Ended without a result (the app stopped)'
    );
  });

  it('does not take an older attempt that stopped without an ending', () => {
    const older = [info({ name: 'old', attempt: 1 })];
    expect(liveRunName(older, task({ attempt: 2 }))).toBeNull();
    expect(liveRunName(older, task({ id: 'run-2' }))).toBeNull();
  });

  it('is nothing when the newest log already ended', () => {
    const ended = [info({ name: 'x', outcome: outcome({ kind: 'stopped' }) })];
    expect(liveRunName(ended, task({}))).toBeNull();
    expect(runRowState(ended[0], null)).toEqual({ kind: 'failed', reason: 'Stopped' });
    const abandoned = [info({ name: 'y', abandoned: 'agent binary not found' })];
    expect(liveRunName(abandoned, task({}))).toBeNull();
    expect(runStateLabel(runRowState(abandoned[0], null))).toBe(
      'Not started: agent binary not found'
    );
  });
});

describe('newestFirst', () => {
  it('sorts by start time, then name, descending', () => {
    const sorted = newestFirst([
      info({ name: 'a', startedAt: 1 }),
      info({ name: 'c', startedAt: 2 }),
      info({ name: 'b', startedAt: 2 }),
    ]);
    expect(sorted.map((r) => r.name)).toEqual(['c', 'b', 'a']);
  });
});

describe('summarizeInput', () => {
  it('prefers the telling field', () => {
    expect(summarizeInput({ command: 'yarn  test\n--run', timeout: 5 })).toBe('yarn test --run');
    expect(summarizeInput({ file_path: 'src/a.ts', content: 'x' })).toBe('src/a.ts');
  });

  it('falls back to compact JSON, truncated to one line', () => {
    expect(summarizeInput({ a: 1 })).toBe('{"a":1}');
    expect(summarizeInput({})).toBe('');
    expect(summarizeInput(null)).toBe('');
    const long = summarizeInput({ text: 'x'.repeat(500) }, 20);
    expect(long).toHaveLength(20);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('eventRow and logRows', () => {
  it('hides session ids and blank text', () => {
    expect(eventRow({ type: 'session', id: 's' })).toBeNull();
    expect(eventRow({ type: 'text', text: '  ' })).toBeNull();
  });

  it('turns events into rows', () => {
    expect(eventRow({ type: 'tool_use', id: '1', name: 'Bash', input: { command: 'ls' } })).toEqual(
      { type: 'tool_use', name: 'Bash', summary: 'ls' }
    );
    expect(eventRow({ type: 'tool_result', id: '1', isError: true, summary: 'nope' })).toEqual({
      type: 'tool_result',
      summary: 'nope',
      isError: true,
    });
    expect(
      eventRow({
        type: 'finished',
        outcome: outcome({ kind: 'completed', turns: 3, costUsd: 0.5 }),
      })
    ).toEqual({ type: 'finished', ok: true, label: 'Completed', detail: '3 turns, $0.50' });
    expect(
      eventRow({ type: 'finished', outcome: outcome({ kind: 'timed_out', costUsd: 0.001 }) })
    ).toEqual({ type: 'finished', ok: false, label: 'Timed out', detail: '$0.0010' });
  });

  it('replays a log without its start line', () => {
    const lines: RunLogLine[] = [
      {
        line: 'start',
        at: 0,
        runId: 'r',
        attempt: 1,
        label: 'run',
        kind: 'dev',
        provider: 'claude',
      },
      { line: 'event', at: 1, event: { type: 'session', id: 's' } },
      { line: 'event', at: 2, event: { type: 'text', text: 'Hello' } },
      { line: 'event', at: 3, event: { type: 'thinking', text: 'Hmm' } },
      { line: 'event', at: 4, event: { type: 'stderr', line: 'warn' } },
    ];
    expect(logRows(lines)).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'thinking', text: 'Hmm' },
      { type: 'stderr', line: 'warn' },
    ]);
    expect(logEnded(lines)).toBe(false);
    const abandoned: RunLogLine[] = [...lines, { line: 'abandoned', at: 5, reason: 'no binary' }];
    expect(logRows(abandoned).at(-1)).toEqual({ type: 'abandoned', reason: 'no binary' });
    expect(logEnded(abandoned)).toBe(true);
  });
});

describe('unseenLive', () => {
  const text = (t: string) => ({ type: 'text' as const, text: t });
  const line = (t: string): RunLogLine => ({ line: 'event', at: 0, event: text(t) });

  it('drops buffered events the replay already has', () => {
    const lines = [line('a'), line('b'), line('c')];
    expect(unseenLive(lines, [text('b'), text('c'), text('d')])).toEqual([text('d')]);
    expect(unseenLive(lines, [text('c')])).toEqual([]);
  });

  it('keeps everything when the replay ended before the buffer began', () => {
    expect(unseenLive([line('a')], [text('b'), text('c')])).toEqual([text('b'), text('c')]);
    expect(unseenLive([], [text('x')])).toEqual([text('x')]);
  });
});
