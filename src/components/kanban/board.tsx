'use client';

/**
 * Kanban Board Component
 *
 * Displays tasks across 6 workflow phases with drag-and-drop support
 */

import { useEffect } from 'react';
import { DndContext, DragEndEvent } from '@dnd-kit/core';
import { useTaskStore } from '@/store/task-store';
import { WORKFLOW_PHASES, WorkflowPhase } from '@/lib/tasks/schema';
import { KanbanColumn } from './column';

export function KanbanBoard() {
  const { tasks, loadTasks, updateTaskPhase } = useTaskStore();

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;

    const taskId = active.id as string;
    const newPhase = over.id as WorkflowPhase;

    await updateTaskPhase(taskId, newPhase);
  };

  return (
    <DndContext onDragEnd={handleDragEnd}>
      <div className="flex gap-4 p-6 overflow-x-auto min-h-screen bg-gray-50">
        {WORKFLOW_PHASES.map((phase) => (
          <KanbanColumn
            key={phase}
            phase={phase}
            tasks={tasks.filter((t) => t.phase === phase)}
          />
        ))}
      </div>
    </DndContext>
  );
}
