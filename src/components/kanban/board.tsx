'use client';

/**
 * Kanban Board Component
 *
 * Displays tasks across 6 workflow phases with drag-and-drop support
 */

import { useEffect, useState } from 'react';
import {
  DndContext,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { useTaskStore } from '@/store/task-store';
import { WORKFLOW_PHASES, WorkflowPhase, Task } from '@/lib/tasks/schema';
import { KanbanColumn } from './column';
import { TaskCard } from './task-card';

export function KanbanBoard() {
  const { tasks, loadTasks, updateTaskPhase } = useTaskStore();
  const [activeTask, setActiveTask] = useState<Task | null>(null);

  // Disable pointer sensor activation delay for instant drag
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // Slight drag before activating (prevents accidental drags)
      },
    })
  );

  useEffect(() => {
    loadTasks();

    // Auto-refresh tasks every 3 seconds to catch background updates
    const interval = setInterval(() => {
      loadTasks();
    }, 3000);

    return () => clearInterval(interval);
  }, [loadTasks]);

  const handleDragStart = (event: DragStartEvent) => {
    const taskId = event.active.id as string;
    const task = tasks.find((t) => t.id === taskId);
    setActiveTask(task || null);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;

    // Clear active task immediately to remove overlay
    setActiveTask(null);

    if (!over) return;

    const taskId = active.id as string;
    const newPhase = over.id as WorkflowPhase;
    const task = tasks.find((t) => t.id === taskId);

    if (!task || task.phase === newPhase) return;

    // Update task phase (optimistic update happens in store)
    await updateTaskPhase(taskId, newPhase);

    // Auto-start agent when moving to "In Progress" phase
    if (newPhase === 'in_progress' && !task.assignedAgent) {
      try {
        const response = await fetch('/api/agents/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: task.id,
            prompt: `Work on task: ${task.title}\n\nDescription: ${task.description}`,
          }),
        });

        if (response.ok) {
          // Reload to show agent status
          window.location.reload();
        }
      } catch (error) {
        console.error('Failed to auto-start agent:', error);
      }
    }
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-4 p-4 overflow-x-auto h-full">
        {WORKFLOW_PHASES.map((phase) => (
          <KanbanColumn
            key={phase}
            phase={phase}
            tasks={tasks.filter((t) => t.phase === phase)}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {activeTask ? (
          <div className="rotate-3 scale-105">
            <TaskCard task={activeTask} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
