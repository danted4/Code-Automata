/**
 * Task Card: one task on the board.
 *
 * The badge and the button come from `lib/task-view.ts`, which reads only the task file: what is
 * running, paused, interrupted (the app quit or crashed mid-step), failed, or waiting on the user.
 * A click opens the view that fits: questions, plan review, human review, else the details.
 */

import { useDraggable } from '@dnd-kit/core';
import { useState, type MouseEvent } from 'react';
import { GitBranch, Info, Loader2, Trash2 } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import type { Task } from '@/lib/api/types/Task';
import { hasWorktrees } from '@/lib/review-summary';
import {
  ACTION_LABELS,
  primaryAction,
  progress,
  PROVIDER_LABELS,
  reworkLabel,
  statusBadge,
  taskStatus,
  type TaskStatus,
} from '@/lib/task-view';
import { act } from '@/store/task-store';
import { useSyncStore } from '@/store/project-sync';
import { useTaskViewStore, type TaskView } from '@/store/task-view-store';

function viewFor(status: TaskStatus): TaskView {
  switch (status.kind) {
    case 'needs_answers':
      return 'questions';
    case 'needs_plan_review':
      return 'plan';
    case 'in_review':
      return 'review';
    default:
      return 'details';
  }
}

function ProgressRow({ label, done, total }: { label: string; done: number; total: number }) {
  if (total === 0) return null;
  const pct = Math.round((done / total) * 100);
  return (
    <div className="space-y-1">
      <div
        className="flex justify-between text-xs"
        style={{ color: 'var(--color-text-secondary)' }}
      >
        <span>{label}</span>
        <span>
          {done}/{total}
        </span>
      </div>
      <div className="h-1.5 rounded-full" style={{ background: 'var(--color-border)' }}>
        <div
          className="h-1.5 rounded-full transition-all"
          style={{ width: `${pct}%`, background: 'var(--color-primary)' }}
        />
      </div>
    </div>
  );
}

export function TaskCard({ task }: { task: Task }) {
  const show = useTaskViewStore((s) => s.show);
  const setView = (view: TaskView) => show(task.id, view);
  const [busy, setBusy] = useState(false);
  const reworkLimit = useSyncStore((s) => s.settings?.reworkLimit ?? null);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });

  const status = taskStatus(task);
  const action = primaryAction(status);
  const badge = statusBadge(status);
  const rework = reworkLabel(task, reworkLimit);
  const dev = progress(task, 'dev');
  const qa = progress(task, 'qa');

  const runAction = async (e: MouseEvent) => {
    e.stopPropagation();
    switch (action) {
      case 'answer':
        return setView('questions');
      case 'review_plan':
        return setView('plan');
      case 'human_review':
        return setView('review');
      case null:
        return;
    }
    setBusy(true);
    const command = {
      pause: api.tasks.pause,
      resume: api.tasks.resume,
      retry: api.tasks.resume,
      start: api.tasks.start,
    }[action];
    await act(() => command(task.id));
    setBusy(false);
  };

  return (
    <>
      <Card
        ref={setNodeRef}
        {...listeners}
        {...attributes}
        data-testid={`task-card-${task.id}`}
        data-status={status.kind}
        className="cursor-grab active:cursor-grabbing hover:shadow-lg transition-shadow"
        style={{
          opacity: isDragging ? 0.3 : 1,
          background: 'var(--color-surface)',
          borderColor: 'var(--color-border)',
        }}
        onClick={() => setView(viewFor(status))}
      >
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2">
            <CardTitle
              data-testid="task-title"
              className="text-sm font-medium line-clamp-2"
              style={{ color: 'var(--color-text-primary)' }}
            >
              {task.title}
            </CardTitle>
            <div className="flex items-center gap-2 shrink-0">
              <Badge
                data-testid="task-status"
                className="whitespace-nowrap"
                style={{ background: badge.bg, color: '#ffffff' }}
              >
                {badge.label}
              </Badge>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setView('delete');
                }}
                className="p-1 rounded hover:opacity-70 transition-opacity"
                style={{ color: 'var(--color-destructive)' }}
                aria-label="Delete task"
                data-testid="delete-task-button"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
          {task.description && (
            <CardDescription
              data-testid="task-description"
              className="line-clamp-2 text-xs"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              {task.description}
            </CardDescription>
          )}
          <div
            className="flex items-center gap-2 mt-2 text-xs"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <span data-testid="task-agent">
              {PROVIDER_LABELS[task.agent.provider] ?? task.agent.provider}
            </span>
            {hasWorktrees(task) && (
              <span className="flex items-center gap-1 min-w-0">
                <GitBranch className="w-3 h-3 shrink-0" />
                <span className="font-mono truncate">code-automata/{task.id}</span>
              </span>
            )}
          </div>
        </CardHeader>

        <CardContent className="pt-0 space-y-2">
          {status.kind === 'working' && (
            <div
              data-testid="task-activity"
              className="flex items-center gap-2 text-xs"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              <Loader2 className="w-3 h-3 animate-spin" />
              <span className="truncate">{status.label}</span>
            </div>
          )}
          {status.kind === 'failed' && (
            <p
              data-testid="task-error"
              className="text-xs line-clamp-3"
              style={{ color: 'var(--color-error)' }}
            >
              {status.error}
            </p>
          )}
          {status.kind === 'interrupted' && (
            <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              Stopped when the app closed. Resume continues where it left off.
            </p>
          )}
          {rework && (
            <Badge
              data-testid="task-rework"
              variant="outline"
              style={{ borderColor: 'var(--color-warning)', color: 'var(--color-warning)' }}
            >
              {rework}
            </Badge>
          )}
          <ProgressRow label="Development" done={dev.done} total={dev.total} />
          <ProgressRow label="QA" done={qa.done} total={qa.total} />
          <div className="flex gap-2">
            {action && (
              <Button
                data-testid={`task-action-${action}`}
                size="sm"
                className="flex-1 text-xs"
                disabled={busy}
                onClick={runAction}
                onPointerDown={(e) => e.stopPropagation()}
                style={{ background: 'var(--color-primary)', color: 'var(--color-primary-text)' }}
              >
                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : ACTION_LABELS[action]}
              </Button>
            )}
            {/* The card click opens questions, plan or review when one is waiting; details are
                always one button away. */}
            <Button
              data-testid="task-details-button"
              size="sm"
              variant="outline"
              className={action ? 'text-xs' : 'flex-1 text-xs'}
              onClick={(e) => {
                e.stopPropagation();
                setView('details');
              }}
              onPointerDown={(e) => e.stopPropagation()}
              aria-label="Task details"
            >
              <Info className="w-3 h-3" />
              {action ? null : <span className="ml-1">Details</span>}
            </Button>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
