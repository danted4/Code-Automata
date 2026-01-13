'use client';

/**
 * Kanban Column Component
 *
 * Represents a single workflow phase column
 */

import { useDroppable } from '@dnd-kit/core';
import { Task, WorkflowPhase, getPhaseDisplayName, getPhaseDescription } from '@/lib/tasks/schema';
import { TaskCard } from './task-card';

interface KanbanColumnProps {
  phase: WorkflowPhase;
  tasks: Task[];
}

export function KanbanColumn({ phase, tasks }: KanbanColumnProps) {
  const { setNodeRef } = useDroppable({
    id: phase,
  });

  return (
    <div
      ref={setNodeRef}
      className="flex-shrink-0 w-80 bg-white rounded-lg shadow-sm border border-gray-200"
    >
      {/* Column Header */}
      <div className="p-4 border-b border-gray-200">
        <h3 className="font-semibold text-lg text-gray-900">
          {getPhaseDisplayName(phase)}
        </h3>
        <p className="text-sm text-gray-500 mt-1">
          {getPhaseDescription(phase)}
        </p>
        <div className="mt-2 text-xs text-gray-400">
          {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
        </div>
      </div>

      {/* Tasks */}
      <div className="p-4 space-y-3 min-h-[200px]">
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} />
        ))}
        {tasks.length === 0 && (
          <div className="text-center py-8 text-gray-400 text-sm">
            No tasks in this phase
          </div>
        )}
      </div>
    </div>
  );
}
