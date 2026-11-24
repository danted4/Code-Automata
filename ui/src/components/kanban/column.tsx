/**
 * Kanban Column: one workflow phase.
 */

import { useDroppable } from '@dnd-kit/core';
import type { Phase } from '@/lib/api/types/Phase';
import type { Task } from '@/lib/api/types/Task';
import { PHASE_LABELS } from '@/lib/task-view';
import { TaskCard } from './task-card';

const PHASE_COLORS: Record<Phase, string> = {
  planning: 'var(--color-phase-planning)',
  in_progress: 'var(--color-status-in-progress)',
  ai_review: 'var(--color-phase-validate)',
  human_review: 'var(--color-phase-discovery)',
  done: 'var(--color-status-completed)',
};

export function KanbanColumn({ phase, tasks }: { phase: Phase; tasks: Task[] }) {
  const { setNodeRef } = useDroppable({ id: phase });

  return (
    <div
      ref={setNodeRef}
      data-testid={`kanban-column-${phase}`}
      className="flex-shrink-0 w-80 rounded-lg border border-t-4"
      style={{
        background: 'var(--color-surface)',
        borderColor: 'var(--color-border)',
        borderTopColor: PHASE_COLORS[phase],
      }}
    >
      <div className="p-4 border-b" style={{ borderColor: 'var(--color-border)' }}>
        <h3 className="font-semibold text-base" style={{ color: 'var(--color-text-primary)' }}>
          {PHASE_LABELS[phase]}
        </h3>
        <div
          data-testid={`task-count-${phase}`}
          className="mt-2 text-xs"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
        </div>
      </div>
      <div
        data-testid={`task-list-${phase}`}
        className="p-3 space-y-3 min-h-[200px] max-h-[calc(100vh-12rem)] overflow-y-auto"
      >
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} />
        ))}
        {tasks.length === 0 && (
          <div
            data-testid={`empty-state-${phase}`}
            className="text-center py-8 text-sm"
            style={{ color: 'var(--color-text-muted)' }}
          >
            No tasks
          </div>
        )}
      </div>
    </div>
  );
}
