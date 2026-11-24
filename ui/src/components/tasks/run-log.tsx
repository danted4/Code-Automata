/**
 * Run Log: the task's agent runs, newest first, and the events of the selected one.
 *
 * The list refetches when the task's run changes (a new step, attempt or state) and when live
 * output shows a log the list does not have yet or one that just finished. The selected log is
 * replayed from the server; when it is the live one, events from the stream are appended after
 * the replay. An event that arrives between the two may be missed; the next replay heals it.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import type { RunLogInfo } from '@/lib/api/types/RunLogInfo';
import { onAgentEvent, type LiveAgentEvent } from '@/lib/agent-events';
import {
  eventRow,
  liveRunName,
  logEnded,
  lastSeq,
  logRows,
  newestFirst,
  runRowState,
  runStateLabel,
  runTitle,
  type DisplayRow,
  type RunRowState,
} from '@/lib/run-log-view';
import { formatTime } from '@/lib/task-detail-view';
import { PROVIDER_LABELS } from '@/lib/task-view';
import { useTask } from '@/store/task-store';

function stateColor(state: RunRowState): string {
  switch (state.kind) {
    case 'running':
      return 'var(--color-info)';
    case 'completed':
      return 'var(--color-success)';
    case 'failed':
      return 'var(--color-error)';
    case 'stopped':
    case 'not_started':
      return 'var(--color-warning)';
    case 'ended':
      return 'var(--color-text-muted)';
  }
}

export function RunLog({ taskId }: { taskId: string }) {
  const task = useTask(taskId);
  const [runs, setRuns] = useState<RunLogInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const refreshing = useRef(false);

  const runId = task?.run?.id;
  const runState = task?.run?.state;
  const attempt = task?.run?.attempt;

  useEffect(() => {
    let cancelled = false;
    api.tasks
      .runs(taskId)
      .then((list) => {
        if (cancelled) return;
        setRuns(list);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) refreshing.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, runId, runState, attempt, reload]);

  const sorted = runs ? newestFirst(runs) : [];
  const liveName = runs ? liveRunName(runs, task) : null;
  const selected = sorted.find((r) => r.name === picked) ?? sorted[0] ?? null;

  // Live output the list cannot place yet (a new log), or that ends a log: refetch the list.
  useEffect(() => {
    return onAgentEvent(taskId, (e) => {
      const ends = e.event.type === 'finished';
      if (!ends && liveName) return;
      if (refreshing.current) return;
      refreshing.current = true;
      setReload((n) => n + 1);
    });
  }, [taskId, liveName]);

  if (error && !runs) {
    return (
      <div data-testid="run-log" className="text-sm" style={{ color: 'var(--color-error)' }}>
        Could not load the runs: {error}
      </div>
    );
  }
  if (!runs) {
    return (
      <div
        data-testid="run-log"
        className="flex items-center gap-2 text-sm"
        style={{ color: 'var(--color-text-secondary)' }}
      >
        <Loader2 className="w-4 h-4 animate-spin" /> Loading runs…
      </div>
    );
  }
  if (sorted.length === 0) {
    return (
      <div data-testid="run-log" className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
        No agent runs yet. They appear here once the task starts.
      </div>
    );
  }

  return (
    <div data-testid="run-log" className="grid gap-3 sm:grid-cols-[240px_minmax(0,1fr)]">
      <ul
        className="space-y-1 overflow-y-auto sm:h-[440px] max-h-[200px] sm:max-h-none pr-1"
        aria-label="Agent runs"
      >
        {sorted.map((info) => {
          const state = runRowState(info, liveName);
          const isSelected = selected?.name === info.name;
          return (
            <li key={info.name}>
              <button
                type="button"
                data-testid={`run-row-${info.name}`}
                aria-pressed={isSelected}
                onClick={() => setPicked(info.name === sorted[0].name ? null : info.name)}
                className="w-full text-left rounded-md border px-2.5 py-2 text-xs transition-colors"
                style={{
                  borderColor: isSelected ? 'var(--color-primary)' : 'var(--color-border)',
                  background: isSelected ? 'var(--color-surface-hover)' : 'var(--color-surface)',
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium" style={{ color: 'var(--color-text-primary)' }}>
                    {runTitle(info)}
                    {info.subtaskId && (
                      <span className="font-mono font-normal"> · {info.subtaskId}</span>
                    )}
                  </span>
                  {state.kind === 'running' && (
                    <Loader2
                      className="w-3 h-3 animate-spin shrink-0"
                      style={{ color: 'var(--color-info)' }}
                    />
                  )}
                </div>
                <div className="mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                  Attempt {info.attempt} · {PROVIDER_LABELS[info.provider] ?? info.provider} ·{' '}
                  {formatTime(info.startedAt)}
                </div>
                <div
                  data-testid={`run-state-${info.name}`}
                  data-state={state.kind}
                  className="mt-0.5 break-words"
                  style={{ color: stateColor(state) }}
                >
                  {runStateLabel(state)}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
      {selected && (
        <RunEvents
          key={selected.name}
          taskId={taskId}
          name={selected.name}
          live={selected.name === liveName}
        />
      )}
    </div>
  );
}

function RunEvents({ taskId, name, live }: { taskId: string; name: string; live: boolean }) {
  const [rows, setRows] = useState<DisplayRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | null = null;
    // Follow first and hold what arrives during the replay's round trip. Only this log's events
    // count (the run may write others, each numbering from 1), and each number is shown once:
    // the server writes a line before it sends the event, so the replay can already have it.
    let held: LiveAgentEvent[] | null = live ? [] : null;
    let ended = false;
    let shown = 0;
    const show = (e: LiveAgentEvent) => {
      if (e.seq <= shown) return;
      shown = e.seq;
      const row = eventRow(e.event);
      if (row) setRows((prev) => [...(prev ?? []), row]);
    };
    if (live) {
      stop = onAgentEvent(taskId, (e) => {
        if (ended || e.log !== name) return;
        if (e.event.type === 'finished') ended = true;
        if (held) held.push(e);
        else show(e);
      });
    }
    api.tasks
      .runLog(taskId, name)
      .then((lines) => {
        if (cancelled) return;
        setRows(logRows(lines));
        setError(null);
        shown = lastSeq(lines);
        const pending = held ?? [];
        held = null;
        if (logEnded(lines)) {
          ended = true;
          return;
        }
        pending.forEach(show);
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [taskId, name, live]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [rows]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const muted = { color: 'var(--color-terminal-text)', opacity: 0.6 };

  return (
    <div
      ref={scroller}
      onScroll={onScroll}
      data-testid="run-events"
      data-live={live ? 'true' : 'false'}
      className="h-[440px] overflow-y-auto rounded-lg p-3 text-xs space-y-2 break-words"
      style={{
        background: 'var(--color-terminal-background)',
        color: 'var(--color-terminal-text)',
      }}
    >
      {error && <div style={{ color: 'var(--color-error)' }}>Could not load the log: {error}</div>}
      {!error && rows === null && (
        <div className="flex items-center gap-2" style={muted}>
          <Loader2 className="w-3 h-3 animate-spin" /> Loading…
        </div>
      )}
      {rows?.length === 0 && (
        <div style={muted}>{live ? 'Waiting for the agent…' : 'No output.'}</div>
      )}
      {rows?.map((row, i) => (
        <EventRow key={i} row={row} />
      ))}
      {live && rows && rows.length > 0 && (
        <div className="flex items-center gap-2" style={muted}>
          <Loader2 className="w-3 h-3 animate-spin" /> Running…
        </div>
      )}
    </div>
  );
}

function EventRow({ row }: { row: DisplayRow }) {
  const muted = { opacity: 0.6 };
  switch (row.type) {
    case 'text':
      return (
        <p data-testid="run-event" data-type="text" className="whitespace-pre-wrap text-sm">
          {row.text}
        </p>
      );
    case 'thinking':
      return (
        <details data-testid="run-event" data-type="thinking" style={muted}>
          <summary className="cursor-pointer select-none italic">Thinking</summary>
          <p className="mt-1 whitespace-pre-wrap italic">{row.text}</p>
        </details>
      );
    case 'tool_use':
      return (
        <div data-testid="run-event" data-type="tool_use" className="font-mono">
          <span style={{ color: 'var(--color-info)' }}>▸ {row.name}</span>
          {row.summary && <span style={{ opacity: 0.75 }}> {row.summary}</span>}
        </div>
      );
    case 'tool_result':
      return (
        <div
          data-testid="run-event"
          data-type="tool_result"
          className="font-mono whitespace-pre-wrap pl-3"
          style={row.isError ? { color: 'var(--color-error)' } : { opacity: 0.75 }}
        >
          ↳ {row.summary || (row.isError ? 'error' : 'ok')}
        </div>
      );
    case 'stderr':
      return (
        <div
          data-testid="run-event"
          data-type="stderr"
          className="font-mono whitespace-pre-wrap"
          style={muted}
        >
          {row.line}
        </div>
      );
    case 'finished':
      return (
        <div
          data-testid="run-event"
          data-type="finished"
          className="border-t pt-2 font-medium"
          style={{
            borderColor: 'var(--color-border)',
            color: row.ok ? 'var(--color-success)' : 'var(--color-error)',
          }}
        >
          ● {row.label}
          {row.detail && <span style={{ opacity: 0.75 }}> · {row.detail}</span>}
        </div>
      );
    case 'abandoned':
      return (
        <div
          data-testid="run-event"
          data-type="abandoned"
          className="border-t pt-2"
          style={{ borderColor: 'var(--color-border)', color: 'var(--color-warning)' }}
        >
          Not started: {row.reason}
        </div>
      );
  }
}
