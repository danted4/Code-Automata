/**
 * What the run log viewer shows, derived from the run list, the log lines and the task file:
 * each run's state, and the display rows for its events. Components render these.
 */

import type { AgentEvent } from '@/lib/api/types/AgentEvent';
import type { Outcome } from '@/lib/api/types/Outcome';
import type { RunKind } from '@/lib/api/types/RunKind';
import type { RunLogInfo } from '@/lib/api/types/RunLogInfo';
import type { RunLogLine } from '@/lib/api/types/RunLogLine';
import type { JsonValue } from '@/lib/api/types/serde_json/JsonValue';
import type { Task } from '@/lib/api/types/Task';
import { isWorking } from '@/lib/task-view';

/** How one logged agent run stands. */
export type RunRowState =
  | { kind: 'running' }
  | { kind: 'completed' }
  /** Ended with an outcome other than completed (agent error, timeout, crash, stop). */
  | { kind: 'failed'; reason: string }
  /** The agent never started. */
  | { kind: 'not_started'; reason: string }
  /** The log stops without an ending: the app quit or crashed mid-run. */
  | { kind: 'ended' };

const KIND_LABELS: Record<RunKind, string> = {
  plan: 'Plan',
  subtask_gen: 'Subtasks',
  dev: 'Dev',
  qa: 'QA',
  checks: 'Checks',
};

/** "Dev", "QA triage", "Plan repair": the run's kind plus its label when it is not plain `run`. */
export function runTitle(info: Pick<RunLogInfo, 'kind' | 'label'>): string {
  const kind = KIND_LABELS[info.kind] ?? info.kind;
  if (info.label === 'run') return kind;
  return `${kind} ${info.label.replace(/^run-/, '').replace(/-/g, ' ')}`;
}

/** Why a run did not complete, from its outcome; null when it completed. */
export function outcomeProblem(outcome: Outcome): string | null {
  switch (outcome.kind) {
    case 'completed':
      return null;
    case 'agent_error':
      return outcome.message ? `Agent error: ${outcome.message}` : 'Agent error';
    case 'timed_out':
      return 'Timed out';
    case 'stopped':
      return 'Stopped';
    case 'crashed':
      return outcome.exitCode == null ? 'Crashed' : `Crashed (exit code ${outcome.exitCode})`;
  }
}

/**
 * The log the task's current step is writing, if any: the newest log of the task's run and
 * attempt with no ending, while the task is working. Older attempts of the same run that stopped
 * without an ending are not live.
 */
export function liveRunName(runs: RunLogInfo[], task: Task | undefined): string | null {
  const run = task?.run;
  if (!task || !run || !isWorking(task)) return null;
  let live: RunLogInfo | null = null;
  for (const info of runs) {
    if (info.runId !== run.id || info.attempt !== run.attempt) continue;
    if (!live || info.startedAt >= live.startedAt) live = info;
  }
  if (!live || live.outcome || live.abandoned) return null;
  return live.name;
}

export function runRowState(info: RunLogInfo, liveName: string | null): RunRowState {
  if (info.outcome) {
    const problem = outcomeProblem(info.outcome);
    return problem ? { kind: 'failed', reason: problem } : { kind: 'completed' };
  }
  if (info.abandoned) return { kind: 'not_started', reason: info.abandoned };
  if (info.name === liveName) return { kind: 'running' };
  return { kind: 'ended' };
}

export function runStateLabel(state: RunRowState): string {
  switch (state.kind) {
    case 'running':
      return 'Running';
    case 'completed':
      return 'Completed';
    case 'failed':
      return state.reason;
    case 'not_started':
      return `Not started: ${state.reason}`;
    case 'ended':
      return 'Ended without a result (the app stopped)';
  }
}

/** Newest first; the server lists oldest first. */
export function newestFirst(runs: RunLogInfo[]): RunLogInfo[] {
  return runs
    .slice()
    .sort((a, b) => b.startedAt - a.startedAt || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

/** One line of the event viewer. */
export type DisplayRow =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; name: string; summary: string }
  | { type: 'tool_result'; summary: string; isError: boolean }
  | { type: 'stderr'; line: string }
  | { type: 'finished'; ok: boolean; label: string; detail: string | null }
  | { type: 'abandoned'; reason: string };

/** Keys whose value says best what a tool call does, in order of preference. */
const SUMMARY_KEYS = [
  'command',
  'file_path',
  'path',
  'pattern',
  'url',
  'query',
  'description',
  'prompt',
];

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One line for a tool's input: its telling field when it has one, else compact JSON. */
export function summarizeInput(input: JsonValue, max = 140): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return oneLine(input, max);
  if (typeof input === 'object' && !Array.isArray(input)) {
    for (const key of SUMMARY_KEYS) {
      const value = input[key];
      if (typeof value === 'string' && value.trim()) return oneLine(value, max);
    }
    if (Object.keys(input).length === 0) return '';
  }
  let json: string;
  try {
    json = JSON.stringify(input);
  } catch {
    json = String(input);
  }
  return oneLine(json, max);
}

function finishedRow(outcome: Outcome): DisplayRow {
  const problem = outcomeProblem(outcome);
  const parts: string[] = [];
  if (typeof outcome.turns === 'number') {
    parts.push(`${outcome.turns} turn${outcome.turns === 1 ? '' : 's'}`);
  }
  if (typeof outcome.costUsd === 'number') {
    parts.push(`$${outcome.costUsd.toFixed(outcome.costUsd < 0.01 ? 4 : 2)}`);
  }
  return {
    type: 'finished',
    ok: problem === null,
    label: problem ?? 'Completed',
    detail: parts.length ? parts.join(', ') : null,
  };
}

/** The display row for one agent event; null for events the viewer hides (session ids). */
export function eventRow(event: AgentEvent): DisplayRow | null {
  switch (event.type) {
    case 'session':
      return null;
    case 'text':
      return event.text.trim() ? { type: 'text', text: event.text } : null;
    case 'thinking':
      return event.text.trim() ? { type: 'thinking', text: event.text } : null;
    case 'tool_use':
      return { type: 'tool_use', name: event.name, summary: summarizeInput(event.input) };
    case 'tool_result':
      return { type: 'tool_result', summary: event.summary, isError: event.isError };
    case 'stderr':
      return { type: 'stderr', line: event.line };
    case 'finished':
      return finishedRow(event.outcome);
  }
}

/** The display rows for a replayed log. The start line is shown by the run list, not here. */
export function logRows(lines: RunLogLine[]): DisplayRow[] {
  const rows: DisplayRow[] = [];
  for (const line of lines) {
    if (line.line === 'event') {
      const row = eventRow(line.event);
      if (row) rows.push(row);
    } else if (line.line === 'abandoned') {
      rows.push({ type: 'abandoned', reason: line.reason });
    }
  }
  return rows;
}

/** Whether a replayed log has ended (an outcome or an abandoned line): nothing more will come. */
export function logEnded(lines: RunLogLine[]): boolean {
  return lines.some(
    (l) => l.line === 'abandoned' || (l.line === 'event' && l.event.type === 'finished')
  );
}

/**
 * Live events that arrived while the log was being replayed, minus those the replay already has.
 * The replay ends somewhere inside the buffered events: drop the longest run of buffered events
 * that matches the end of the replay, keep the rest.
 */
export function unseenLive(lines: RunLogLine[], buffered: AgentEvent[]): AgentEvent[] {
  const replayed = lines.flatMap((l) => (l.line === 'event' ? [JSON.stringify(l.event)] : []));
  const live = buffered.map((e) => JSON.stringify(e));
  for (let k = Math.min(replayed.length, live.length); k > 0; k--) {
    const tail = replayed.slice(replayed.length - k);
    if (tail.every((e, i) => e === live[i])) return buffered.slice(k);
  }
  return buffered;
}
