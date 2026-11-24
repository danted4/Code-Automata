/**
 * Kanban Board Component
 *
 * Displays tasks across the five workflow phases. Dragging a card only moves it: the backend
 * decides whether the move is allowed, and agents are started from buttons, never by a drop.
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
import { toast } from 'sonner';
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
    loadTasks();

    // Auto-refresh tasks every 3 seconds to catch background updates
    const interval = setInterval(() => loadTasks(), 3000);

    // Reload when the window becomes visible again
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        loadTasks();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
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

    await updateTaskPhase(taskId, newPhase);
    const error = useTaskStore.getState().error;
    if (error) toast.error(`Cannot move the task: ${error}`);
  };

  return (
    <>
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        {/* Extends under fixed sidebar so columns slide under when scrolling horizontally */}
        <div className="flex gap-4 p-4 pl-[272px] overflow-x-auto h-full -ml-64 w-[calc(100%+16rem)]">
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
