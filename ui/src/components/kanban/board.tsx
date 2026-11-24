/**
 * Kanban Board
 *
 * The five workflow columns. Dragging a card only moves it: the server decides whether the move
 * is allowed, and agents start from buttons, never from a drop. The list stays current through
 * the project's event stream (see store/project-sync.ts); there is no polling.
 */

import { useState } from 'react';
import {
  DndContext,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';
import type { Phase } from '@/lib/api/types/Phase';
import type { Task } from '@/lib/api/types/Task';
import { PHASES } from '@/lib/task-view';
import { act, useTaskStore } from '@/store/task-store';
import { useSyncStore } from '@/store/project-sync';
import { KanbanColumn } from './column';
import { TaskCard } from './task-card';
import { TaskDialogs } from './task-dialogs';

export function KanbanBoard() {
  const tasks = useTaskStore((s) => s.tasks);
  const skipped = useTaskStore((s) => s.skipped);
  const loadError = useTaskStore((s) => s.error);
  const stream = useSyncStore((s) => s.stream);
  const streamError = useSyncStore((s) => s.streamError);
  const retryLoad = () => void useTaskStore.getState().load();
  const [activeTask, setActiveTask] = useState<Task | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 }, // a click is not a drag
    })
  );

  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const deleteUnreadable = async (id: string) => {
    // First click arms, second deletes: no browser dialog.
    if (confirmDelete !== id) return setConfirmDelete(id);
    setConfirmDelete(null);
    try {
      await api.tasks.remove(id);
      toast.success('Task deleted');
      void useTaskStore.getState().load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveTask(tasks.find((t) => t.id === event.active.id) ?? null);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveTask(null);
    const { active, over } = event;
    if (!over) return;
    const task = tasks.find((t) => t.id === active.id);
    const to = over.id as Phase;
    if (!task || task.phase === to) return;
    await act(() => api.tasks.move(task.id, to));
  };

  return (
    <>
      {(stream !== 'open' || loadError) && (
        <div
          data-testid="board-notice"
          className="mx-4 mt-3 rounded-md border px-3 py-2 text-xs"
          style={{ borderColor: 'var(--color-border)', color: 'var(--color-warning)' }}
        >
          {loadError ? (
            <span className="flex items-center gap-2">
              Cannot load tasks: {loadError}. Retrying…
              <Button
                data-testid="board-retry"
                size="sm"
                variant="outline"
                className="h-6 text-xs"
                onClick={retryLoad}
              >
                Retry now
              </Button>
            </span>
          ) : stream === 'refused' ? (
            `The server refused this project: ${streamError ?? 'unknown reason'}`
          ) : (
            'Reconnecting to the Code-Automata server…'
          )}
        </div>
      )}
      {skipped.length > 0 && (
        <div
          data-testid="board-unreadable"
          className="mx-4 mt-3 rounded-md border px-3 py-2 text-xs space-y-1"
          style={{ borderColor: 'var(--color-border)', color: 'var(--color-warning)' }}
        >
          <p>
            {skipped.length} task file{skipped.length === 1 ? '' : 's'} could not be read. Fix the
            file by hand, or delete the task:
          </p>
          {skipped.map((s) => (
            <div key={s.taskId} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono" title={s.error}>
                {s.taskId}: {s.error}
              </span>
              <Button
                data-testid={`unreadable-delete-${s.taskId}`}
                size="sm"
                variant="outline"
                className="h-6 text-xs"
                onClick={() => deleteUnreadable(s.taskId)}
              >
                {confirmDelete === s.taskId ? 'Delete task, worktree and branch?' : 'Delete'}
              </Button>
            </div>
          ))}
        </div>
      )}
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        {/* Extends under the fixed sidebar so columns slide under it when scrolling sideways */}
        <div className="flex gap-4 p-4 pl-[272px] overflow-x-auto h-full -ml-64 w-[calc(100%+16rem)]">
          {PHASES.map((phase) => (
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
      <TaskDialogs />
    </>
  );
}
