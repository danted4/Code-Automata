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
import { useProjectStore } from '@/store/project-store';
import { WORKFLOW_PHASES, WorkflowPhase, Task } from '@/lib/tasks/schema';
import { KanbanColumn } from './column';
import { TaskCard } from './task-card';
import { EditTaskModal } from '@/components/tasks/edit-task-modal';

export function KanbanBoard() {
  const { tasks, loadTasks, updateTaskPhase } = useTaskStore();
  const projectPath = useProjectStore((s) => s.projectPath);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [editModalTask, setEditModalTask] = useState<Task | null>(null);

  // Disable pointer sensor activation delay for instant drag
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // Slight drag before activating (prevents accidental drags)
      },
    })
  );

  useEffect(() => {
    // Load immediately and again after delay (handles API cold-start in dev)
    loadTasks();
    const delayedTimer = setTimeout(() => loadTasks(), 600);

    // Auto-refresh tasks every 3 seconds to catch background updates
    const interval = setInterval(() => loadTasks(), 3000);

    // Reload when window becomes visible (fixes race when Electron opens before server ready)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        loadTasks();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      clearTimeout(delayedTimer);
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [loadTasks, projectPath]);

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
    <>
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="flex gap-4 p-4 overflow-x-auto h-full">
          {WORKFLOW_PHASES.map((phase) => (
            <KanbanColumn
              key={phase}
              phase={phase}
              tasks={tasks.filter((t) => t.phase === phase)}
              onEditBlockedTask={setEditModalTask}
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

      <EditTaskModal
        open={!!editModalTask}
        onOpenChange={(open) => !open && setEditModalTask(null)}
        task={editModalTask}
      />
    </>
  );
}
