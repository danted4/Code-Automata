/**
 * Task Detail Modal: everything about one task. The header has its status, any error, and the
 * card's primary action; the tabs show the plan, the subtasks (with Skip), the AI review results
 * and the agent run logs.
 *
 * Actions that open another view (answering questions, reviewing the plan, human review) stay on
 * the card; this view points there instead.
 */

import { useState } from 'react';
import {
  CheckCircle2,
  Circle,
  CircleSlash,
  Loader2,
  Pencil,
  SkipForward,
  XCircle,
} from 'lucide-react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import type { Task } from '@/lib/api/types/Task';
import {
  ACTION_LABELS,
  PHASE_LABELS,
  primaryAction,
  progress,
  PROVIDER_LABELS,
  reworkLabel,
  statusBadge,
  taskStatus,
  type PrimaryAction,
} from '@/lib/task-view';
import {
  actionHint,
  defaultTab,
  formatTime,
  shortSha,
  subtaskRows,
  type DetailTab,
  type SubtaskRow,
} from '@/lib/task-detail-view';
import { useSyncStore } from '@/store/project-sync';
import { act, useTask } from '@/store/task-store';
import { EditTaskModal } from './edit-task-modal';
import type { TaskModalProps } from './modal-props';
import { PlanMarkdown } from './plan-markdown';
import { RunLog } from './run-log';

const COMMANDS: Partial<Record<Exclude<PrimaryAction, null>, (id: string) => Promise<Task>>> = {
  pause: api.tasks.pause,
  resume: api.tasks.resume,
  retry: api.tasks.resume,
  start: api.tasks.start,
};

const TABS: { id: DetailTab; label: string }[] = [
  { id: 'plan', label: 'Plan' },
  { id: 'subtasks', label: 'Subtasks' },
  { id: 'review', label: 'Review' },
  { id: 'runs', label: 'Runs' },
];

const secondary = { color: 'var(--color-text-secondary)' };
const muted = { color: 'var(--color-text-muted)' };

export function TaskDetailModal({ taskId, open, onOpenChange }: TaskModalProps) {
  const task = useTask(taskId);
  const reworkLimit = useSyncStore((s) => s.settings?.reworkLimit ?? null);
  const [tab, setTab] = useState<DetailTab>(() => (task ? defaultTab(task) : 'runs'));
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!task) return null;

  const status = taskStatus(task);
  const action = primaryAction(status);
  const badge = statusBadge(status);
  const rework = reworkLabel(task, reworkLimit);
  const hint = actionHint(action);
  const command = action ? COMMANDS[action] : undefined;
  const subtaskCount = task.subtasks?.length ?? 0;

  const runAction = async () => {
    if (!command || !action) return;
    setBusy(true);
    await act(() => command(task.id));
    setBusy(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[900px] h-[90vh]" data-testid="task-detail-modal">
        <DialogHeader className="pr-6">
          <DialogTitle data-testid="task-detail-title">{task.title}</DialogTitle>
          {task.description ? (
            <DialogDescription
              data-testid="task-detail-description"
              className="whitespace-pre-wrap max-h-24 overflow-y-auto"
            >
              {task.description}
            </DialogDescription>
          ) : (
            <DialogDescription className="sr-only">Task details</DialogDescription>
          )}
        </DialogHeader>

        <div className="shrink-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge
              data-testid="task-detail-status"
              data-status={status.kind}
              style={{ background: badge.bg, color: '#ffffff' }}
            >
              {badge.label}
            </Badge>
            <Badge
              data-testid="task-detail-phase"
              variant="outline"
              style={{ borderColor: 'var(--color-border)', ...secondary }}
            >
              {PHASE_LABELS[task.phase]}
            </Badge>
            {rework && (
              <Badge
                data-testid="task-detail-rework"
                variant="outline"
                style={{ borderColor: 'var(--color-warning)', color: 'var(--color-warning)' }}
              >
                {rework}
              </Badge>
            )}
            <span data-testid="task-detail-agent" style={muted}>
              {PROVIDER_LABELS[task.agent.provider] ?? task.agent.provider}
              {task.agent.model && ` · ${task.agent.model}`}
              {task.agent.mode && ` · ${task.agent.mode}`}
            </span>
            {status.kind === 'working' && (
              <span
                data-testid="task-detail-activity"
                className="flex items-center gap-1"
                style={secondary}
              >
                <Loader2 className="w-3 h-3 animate-spin" />
                {status.label}
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Button
                data-testid="task-detail-edit"
                variant="outline"
                size="sm"
                onClick={() => setEditing(true)}
                style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
              >
                <Pencil className="w-3.5 h-3.5" /> Edit
              </Button>
              {command && action && (
                <Button
                  data-testid="task-detail-action"
                  data-action={action}
                  size="sm"
                  disabled={busy}
                  onClick={runAction}
                  style={{
                    background: 'var(--color-primary)',
                    color: 'var(--color-primary-text)',
                  }}
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : ACTION_LABELS[action]}
                </Button>
              )}
            </div>
          </div>

          {hint && (
            <p data-testid="task-detail-action-hint" className="text-xs" style={secondary}>
              {hint}
            </p>
          )}
          {status.kind === 'failed' && (
            <pre
              data-testid="task-detail-error"
              className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md border p-2 text-xs font-mono"
              style={{ borderColor: 'var(--color-error)', color: 'var(--color-error)' }}
            >
              {status.error}
            </pre>
          )}
          {status.kind === 'interrupted' && (
            <p data-testid="task-detail-interrupted" className="text-xs" style={secondary}>
              The app stopped mid-step. Resume continues the same subtask with its partial work.
            </p>
          )}
          {status.kind === 'paused' && (
            <p data-testid="task-detail-paused" className="text-xs" style={secondary}>
              Paused. Resume continues the same subtask.
            </p>
          )}

          <div className="flex gap-1 border-b" style={{ borderColor: 'var(--color-border)' }}>
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                data-testid={`task-detail-tab-${t.id}`}
                aria-selected={tab === t.id}
                role="tab"
                onClick={() => setTab(t.id)}
                className="relative px-4 py-2 text-sm font-medium transition-colors"
                style={{
                  color: tab === t.id ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                }}
              >
                {t.label}
                {t.id === 'subtasks' && subtaskCount > 0 && ` (${subtaskCount})`}
                {tab === t.id && (
                  <span
                    className="absolute bottom-0 left-0 right-0 h-0.5"
                    style={{ background: 'var(--color-primary)' }}
                  />
                )}
              </button>
            ))}
          </div>
        </div>

        <DialogBody className="pr-1">
          {tab === 'plan' && <PlanTab task={task} />}
          {tab === 'subtasks' && <SubtasksTab task={task} />}
          {tab === 'review' && <ReviewTab task={task} />}
          {tab === 'runs' && <RunLog taskId={task.id} />}
        </DialogBody>

        {editing && (
          <EditTaskModal
            taskId={task.id}
            open
            onOpenChange={(o) => {
              if (!o) setEditing(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function PlanTab({ task }: { task: Task }) {
  const { plan, revision } = task.planning;
  return (
    <div data-testid="task-detail-plan" className="space-y-3">
      {revision && (
        <div
          data-testid="task-detail-plan-revision"
          className="rounded-md border p-2 text-xs"
          style={{ borderColor: 'var(--color-info)', ...secondary }}
        >
          <span className="font-medium" style={{ color: 'var(--color-info)' }}>
            Revision requested:
          </span>{' '}
          <span className="whitespace-pre-wrap">{revision}</span>
        </div>
      )}
      {plan ? (
        <PlanMarkdown markdown={plan} />
      ) : (
        <p className="text-sm" style={muted}>
          No plan yet.
        </p>
      )}
    </div>
  );
}

function SubtasksTab({ task }: { task: Task }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [skipping, setSkipping] = useState<string | null>(null);
  const { dev, qa } = subtaskRows(task);
  const devProgress = progress(task, 'dev');
  const qaProgress = progress(task, 'qa');

  if (dev.length === 0 && qa.length === 0) {
    return (
      <p className="text-sm" style={muted}>
        No subtasks yet. They are written when development starts.
      </p>
    );
  }

  const skip = async (subtaskId: string) => {
    setSkipping(subtaskId);
    await act(() => api.tasks.skipSubtask(task.id, subtaskId), 'Subtask skipped');
    setSkipping(null);
    setConfirming(null);
  };

  const list = (title: string, rows: SubtaskRow[], done: number, total: number) =>
    rows.length > 0 && (
      <section className="space-y-2">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>
          {title}{' '}
          <span className="font-normal" style={muted}>
            {done}/{total}
          </span>
        </h3>
        {rows.map((row) => (
          <SubtaskItem
            key={row.subtask.id}
            task={task}
            row={row}
            confirming={confirming === row.subtask.id}
            skipping={skipping === row.subtask.id}
            onSkip={() => setConfirming(row.subtask.id)}
            onCancel={() => setConfirming(null)}
            onConfirm={() => skip(row.subtask.id)}
          />
        ))}
      </section>
    );

  return (
    <div className="space-y-5">
      {list('Development', dev, devProgress.done, devProgress.total)}
      {list('QA', qa, qaProgress.done, qaProgress.total)}
    </div>
  );
}

function StatusIcon({ row }: { row: SubtaskRow }) {
  const cls = 'w-4 h-4 shrink-0 mt-0.5';
  if (row.running)
    return <Loader2 className={`${cls} animate-spin`} style={{ color: 'var(--color-info)' }} />;
  switch (row.subtask.status) {
    case 'done':
      return <CheckCircle2 className={cls} style={{ color: 'var(--color-success)' }} />;
    case 'skipped':
      return <CircleSlash className={cls} style={muted} />;
    case 'pending':
      return <Circle className={cls} style={muted} />;
  }
}

const HALTED_LABELS: Record<string, string> = {
  paused: 'Paused on this subtask',
  interrupted: 'Interrupted on this subtask',
  failed: 'Failed on this subtask',
};

function SubtaskItem({
  task,
  row,
  confirming,
  skipping,
  onSkip,
  onCancel,
  onConfirm,
}: {
  task: Task;
  row: SubtaskRow;
  confirming: boolean;
  skipping: boolean;
  onSkip: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const s = row.subtask;
  const halted = row.current && !row.running ? HALTED_LABELS[task.run?.state ?? ''] : undefined;
  const meta: string[] = [];
  if (s.reworkRound) meta.push(`Rework round ${s.reworkRound}`);
  if (s.checkpoint) meta.push(`Checkpoint ${shortSha(s.checkpoint)}`);
  if (s.finishedAt) meta.push(`Finished ${formatTime(s.finishedAt)}`);

  return (
    <div
      data-testid={`subtask-row-${s.id}`}
      data-status={s.status}
      data-running={row.running ? 'true' : 'false'}
      className="rounded-lg border p-3"
      style={{
        borderColor: row.current ? 'var(--color-primary)' : 'var(--color-border)',
        background: 'var(--color-surface)',
        opacity: s.status === 'skipped' ? 0.7 : 1,
      }}
    >
      <div className="flex items-start gap-2">
        <StatusIcon row={row} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-start justify-between gap-2">
            <div className="text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>
              {s.title}
              <span className="ml-2 font-mono text-xs font-normal" style={muted}>
                {s.id}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span
                data-testid={`subtask-status-${s.id}`}
                className="rounded px-2 py-0.5 text-xs"
                style={{ background: 'var(--color-surface-hover)', ...secondary }}
              >
                {s.status}
              </span>
              {row.canSkip && !confirming && (
                <Button
                  data-testid={`subtask-skip-${s.id}`}
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={onSkip}
                  style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
                >
                  <SkipForward className="w-3 h-3" /> Skip
                </Button>
              )}
            </div>
          </div>

          {row.running && (
            <div
              data-testid={`subtask-running-${s.id}`}
              className="text-xs"
              style={{ color: 'var(--color-info)' }}
            >
              Running{s.progressLabel ? `: ${s.progressLabel}` : ''}
            </div>
          )}
          {halted && (
            <div className="text-xs" style={{ color: 'var(--color-warning)' }}>
              {halted}
            </div>
          )}

          {s.detail && (
            <p className="whitespace-pre-wrap text-xs" style={secondary}>
              {s.detail}
            </p>
          )}
          {meta.length > 0 && (
            <div className="text-xs" style={muted}>
              {meta.join(' · ')}
            </div>
          )}
          {s.skippedReason && (
            <div className="text-xs" style={{ color: 'var(--color-warning)' }}>
              Skipped: {s.skippedReason}
            </div>
          )}
          {s.handoff && (
            <div className="text-xs" style={secondary}>
              <span className="font-medium">Handoff:</span>{' '}
              <span className="whitespace-pre-wrap">{s.handoff}</span>
            </div>
          )}
          {s.verdict && (
            <div data-testid={`subtask-verdict-${s.id}`} className="space-y-1 text-xs">
              <div className="flex items-center gap-1">
                {s.verdict.passed ? (
                  <CheckCircle2 className="w-3.5 h-3.5" style={{ color: 'var(--color-success)' }} />
                ) : (
                  <XCircle className="w-3.5 h-3.5" style={{ color: 'var(--color-error)' }} />
                )}
                <span
                  className="font-medium"
                  style={{
                    color: s.verdict.passed ? 'var(--color-success)' : 'var(--color-error)',
                  }}
                >
                  {s.verdict.passed ? 'Passed' : 'Failed'}
                </span>
                <span style={secondary}>{s.verdict.summary}</span>
              </div>
              {s.verdict.findings && s.verdict.findings.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-5" style={secondary}>
                  {s.verdict.findings.map((f, i) => (
                    <li key={i} className="whitespace-pre-wrap">
                      {f}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {confirming && (
            <div
              className="mt-2 flex flex-wrap items-center gap-2 rounded-md border p-2 text-xs"
              style={{ borderColor: 'var(--color-warning)', ...secondary }}
            >
              <span className="flex-1">
                Skip this subtask? Any partial work on it is dropped and it will not run.
              </span>
              <Button
                data-testid="subtask-skip-cancel"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={skipping}
                onClick={onCancel}
                style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
              >
                Cancel
              </Button>
              <Button
                data-testid="subtask-skip-confirm"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={skipping}
                onClick={onConfirm}
                style={{ background: 'var(--color-warning)', color: '#000000' }}
              >
                {skipping ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Skip subtask'}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ReviewTab({ task }: { task: Task }) {
  const review = task.review;
  if (!review) {
    return (
      <p className="text-sm" style={muted}>
        No AI review yet. It runs after development.
      </p>
    );
  }
  const checks = review.checks;
  return (
    <div data-testid="task-detail-review" className="space-y-4 text-sm">
      <section data-testid="task-detail-checks" className="space-y-2">
        <h3 className="font-semibold" style={{ color: 'var(--color-text-primary)' }}>
          Automated checks
        </h3>
        {checks ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {checks.passed ? (
                <CheckCircle2 className="w-4 h-4" style={{ color: 'var(--color-success)' }} />
              ) : (
                <XCircle className="w-4 h-4" style={{ color: 'var(--color-error)' }} />
              )}
              <span
                data-testid="task-detail-checks-result"
                className="font-medium"
                style={{ color: checks.passed ? 'var(--color-success)' : 'var(--color-error)' }}
              >
                {checks.passed ? 'Passed' : 'Failed'}
              </span>
              <span style={secondary}>{checks.summary}</span>
              <span className="ml-auto font-mono text-xs" style={muted}>
                {shortSha(checks.commit)} · {formatTime(checks.at)}
              </span>
            </div>
            {checks.details && (
              <pre
                className="max-h-64 overflow-auto rounded-md p-2 text-xs font-mono whitespace-pre-wrap break-words"
                style={{
                  background: 'var(--color-terminal-background)',
                  color: 'var(--color-terminal-text)',
                }}
              >
                {checks.details}
              </pre>
            )}
          </>
        ) : (
          <p style={muted}>Not run yet.</p>
        )}
      </section>

      <section className="space-y-1">
        <h3 className="font-semibold" style={{ color: 'var(--color-text-primary)' }}>
          Rework
        </h3>
        <p data-testid="task-detail-rework-count" style={secondary}>
          {review.reworkCount === 0
            ? 'No rework rounds so far.'
            : `${review.reworkCount} rework round${review.reworkCount === 1 ? '' : 's'} so far.`}
        </p>
        {review.feedback && (
          <div
            data-testid="task-detail-feedback"
            className="whitespace-pre-wrap rounded-md border p-2 text-xs"
            style={{ borderColor: 'var(--color-border)', ...secondary }}
          >
            {review.feedback}
          </div>
        )}
      </section>
    </div>
  );
}
