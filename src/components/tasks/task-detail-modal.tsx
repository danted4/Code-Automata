'use client';

/**
 * Task Detail Modal
 *
 * Shows task subtasks and logs in tabbed interface
 */

import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Task, Subtask } from '@/lib/tasks/schema';
import { CheckCircle2, Circle, Loader2, Trash2, SkipForward, GripVertical } from 'lucide-react';
import { toast } from 'sonner';
import { useTaskStore } from '@/store/task-store';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface TaskDetailModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: Task;
}

type TabType = 'subtasks' | 'logs';

interface SortableSubtaskItemProps {
  subtask: Subtask;
  index: number;
  isDraggable: boolean;
  getSubtaskIcon: (subtask: Subtask) => React.ReactElement;
  canModifySubtask: (subtask: Subtask, index: number) => boolean;
  handleSkipSubtask: (subtaskId: string) => void;
  handleDeleteSubtask: (subtaskId: string) => void;
  isSkipping: string | null;
  isDeleting: string | null;
}

function SortableSubtaskItem({
  subtask,
  index,
  isDraggable,
  getSubtaskIcon,
  canModifySubtask,
  handleSkipSubtask,
  handleDeleteSubtask,
  isSkipping,
  isDeleting,
}: SortableSubtaskItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: subtask.id, disabled: !isDraggable });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    background: subtask.status === 'in_progress'
      ? 'var(--color-surface-hover)'
      : 'var(--color-surface)',
    borderColor: subtask.status === 'in_progress'
      ? 'var(--color-info)'
      : 'var(--color-border)',
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-start gap-3 p-3 rounded-lg border"
    >
      {/* Drag Handle - only show for draggable items */}
      {isDraggable && (
        <div
          className="mt-0.5 cursor-grab active:cursor-grabbing"
          style={{
            userSelect: 'none',
            WebkitUserSelect: 'none',
            MozUserSelect: 'none',
            msUserSelect: 'none',
            touchAction: 'none',
          }}
          {...attributes}
          {...listeners}
        >
          <GripVertical
            className="w-5 h-5"
            style={{ color: 'var(--color-text-muted)' }}
          />
        </div>
      )}

      {/* Icon */}
      <div className="mt-0.5">
        {getSubtaskIcon(subtask)}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="font-medium text-sm" style={{ color: 'var(--color-text-primary)' }}>
            {index + 1}. {subtask.label}
          </div>
          <div className="text-xs px-2 py-0.5 rounded" style={{
            background: subtask.status === 'completed'
              ? 'var(--color-success)'
              : subtask.status === 'in_progress'
              ? 'var(--color-info)'
              : 'var(--color-surface-hover)',
            color: subtask.status === 'pending' ? 'var(--color-text-secondary)' : '#ffffff',
          }}>
            {subtask.status.replace('_', ' ')}
          </div>
        </div>
        <div className="mt-1 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
          {subtask.content}
        </div>
      </div>

      {/* Actions */}
      {canModifySubtask(subtask, index) && (
        <div className="flex gap-1">
          <button
            onClick={() => handleSkipSubtask(subtask.id)}
            disabled={isSkipping === subtask.id}
            className="p-1.5 rounded-md transition-all"
            style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              opacity: isSkipping === subtask.id ? 0.5 : 1,
            }}
            onMouseEnter={(e) => {
              if (isSkipping !== subtask.id) {
                e.currentTarget.style.background = 'var(--color-warning)';
                e.currentTarget.style.borderColor = 'var(--color-warning)';
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--color-surface)';
              e.currentTarget.style.borderColor = 'var(--color-border)';
            }}
            title="Skip subtask"
          >
            {isSkipping === subtask.id ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <SkipForward className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            onClick={() => handleDeleteSubtask(subtask.id)}
            disabled={isDeleting === subtask.id}
            className="p-1.5 rounded-md transition-all"
            style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              opacity: isDeleting === subtask.id ? 0.5 : 1,
            }}
            onMouseEnter={(e) => {
              if (isDeleting !== subtask.id) {
                e.currentTarget.style.background = 'var(--color-destructive)';
                e.currentTarget.style.borderColor = 'var(--color-destructive)';
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--color-surface)';
              e.currentTarget.style.borderColor = 'var(--color-border)';
            }}
            title="Delete subtask"
          >
            {isDeleting === subtask.id ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Trash2 className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      )}
    </div>
  );
}

export function TaskDetailModal({ open, onOpenChange, task }: TaskDetailModalProps) {
  const [activeTab, setActiveTab] = useState<TabType>('subtasks');
  const [logs, setLogs] = useState<string[]>([]);
  const [isDeleting, setIsDeleting] = useState<string | null>(null);
  const [isSkipping, setIsSkipping] = useState<string | null>(null);
  const [subtasks, setSubtasks] = useState<Subtask[]>(task.subtasks);
  const { loadTasks } = useTaskStore();

  // Update local subtasks when task changes
  useEffect(() => {
    setSubtasks(task.subtasks);
  }, [task.subtasks]);

  // Drag-and-drop sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5, // Require 5px movement before drag starts
        delay: 0,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Find current in_progress subtask for logs
  const currentSubtask = task.subtasks.find(s => s.status === 'in_progress');

  // Auto-switch to logs tab when a subtask is in progress
  useEffect(() => {
    if (currentSubtask && activeTab === 'subtasks') {
      // Don't auto-switch if user explicitly selected subtasks tab
    }
  }, [currentSubtask]);

  const handleDeleteSubtask = async (subtaskId: string) => {
    setIsDeleting(subtaskId);

    // Optimistic update - remove immediately from local state
    const originalSubtasks = [...subtasks];
    setSubtasks(prev => prev.filter(s => s.id !== subtaskId));

    try {
      const response = await fetch('/api/tasks/delete-subtask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: task.id,
          subtaskId,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        toast.error(error.error || 'Failed to delete subtask');
        // Revert on error
        setSubtasks(originalSubtasks);
        return;
      }

      toast.success('Subtask deleted successfully');
      await loadTasks(); // Refresh tasks to sync with backend
    } catch (error) {
      toast.error('Failed to delete subtask');
      // Revert on error
      setSubtasks(originalSubtasks);
      console.error(error);
    } finally {
      setIsDeleting(null);
    }
  };

  const handleSkipSubtask = async (subtaskId: string) => {
    setIsSkipping(subtaskId);

    // Optimistic update - mark as completed immediately
    const originalSubtasks = [...subtasks];
    setSubtasks(prev => prev.map(s =>
      s.id === subtaskId ? { ...s, status: 'completed' as const } : s
    ));

    try {
      const response = await fetch('/api/tasks/skip-subtask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: task.id,
          subtaskId,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        toast.error(error.error || 'Failed to skip subtask');
        // Revert on error
        setSubtasks(originalSubtasks);
        return;
      }

      toast.success('Subtask skipped successfully');
      await loadTasks(); // Refresh tasks to sync with backend
    } catch (error) {
      toast.error('Failed to skip subtask');
      // Revert on error
      setSubtasks(originalSubtasks);
      console.error(error);
    } finally {
      setIsSkipping(null);
    }
  };

  const getSubtaskIcon = (subtask: Subtask) => {
    if (subtask.status === 'completed') {
      return <CheckCircle2 className="w-5 h-5" style={{ color: 'var(--color-success)' }} />;
    } else if (subtask.status === 'in_progress') {
      return <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--color-info)' }} />;
    } else {
      return <Circle className="w-5 h-5" style={{ color: 'var(--color-border)' }} />;
    }
  };

  const canModifySubtask = (subtask: Subtask, index: number) => {
    // Find the current in_progress subtask
    const inProgressIndex = task.subtasks.findIndex(s => s.status === 'in_progress');

    // If there's an in_progress subtask, only allow modifying pending ones that come AFTER it
    if (inProgressIndex !== -1) {
      return subtask.status === 'pending' && index > inProgressIndex;
    }

    // If no in_progress subtask, allow modifying any pending subtask
    return subtask.status === 'pending';
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;

    if (!over || active.id === over.id) {
      return;
    }

    const oldIndex = subtasks.findIndex((s) => s.id === active.id);
    const newIndex = subtasks.findIndex((s) => s.id === over.id);

    // Reorder locally for immediate feedback
    const reorderedSubtasks = arrayMove(subtasks, oldIndex, newIndex);
    setSubtasks(reorderedSubtasks);

    // Persist to backend
    try {
      const response = await fetch('/api/tasks/reorder-subtasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: task.id,
          subtaskIds: reorderedSubtasks.map(s => s.id),
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        toast.error(error.error || 'Failed to reorder subtasks');
        // Revert on error
        setSubtasks(task.subtasks);
        return;
      }

      toast.success('Subtasks reordered');
      await loadTasks();
    } catch (error) {
      toast.error('Failed to reorder subtasks');
      // Revert on error
      setSubtasks(task.subtasks);
      console.error(error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[800px] max-h-[90vh] overflow-hidden flex flex-col"
      >
        <DialogHeader>
          <DialogTitle>{task.title || task.id}</DialogTitle>
          <DialogDescription>
            {task.description}
          </DialogDescription>
        </DialogHeader>

        {/* Tabs */}
        <div className="flex gap-1 border-b" style={{ borderColor: 'var(--color-border)' }}>
          <button
            onClick={() => setActiveTab('subtasks')}
            className="px-4 py-2 text-sm font-medium transition-all relative"
            style={{
              color: activeTab === 'subtasks' ? 'var(--color-primary)' : 'var(--color-text-secondary)',
            }}
          >
            Subtasks ({task.subtasks.length})
            {activeTab === 'subtasks' && (
              <div
                className="absolute bottom-0 left-0 right-0 h-0.5"
                style={{ background: 'var(--color-primary)' }}
              />
            )}
          </button>
          <button
            onClick={() => setActiveTab('logs')}
            className="px-4 py-2 text-sm font-medium transition-all relative"
            style={{
              color: activeTab === 'logs' ? 'var(--color-primary)' : 'var(--color-text-secondary)',
            }}
          >
            Logs
            {currentSubtask && activeTab === 'logs' && (
              <Loader2 className="w-3 h-3 ml-1 inline animate-spin" style={{ color: 'var(--color-info)' }} />
            )}
            {activeTab === 'logs' && (
              <div
                className="absolute bottom-0 left-0 right-0 h-0.5"
                style={{ background: 'var(--color-primary)' }}
              />
            )}
          </button>
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto py-4 px-2" style={{ minHeight: '500px', maxHeight: '500px' }}>
          {activeTab === 'subtasks' ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={subtasks.map(s => s.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="space-y-3">
                  {subtasks.map((subtask, index) => {
                    const isDraggable = canModifySubtask(subtask, index);
                    return (
                      <SortableSubtaskItem
                        key={subtask.id}
                        subtask={subtask}
                        index={index}
                        isDraggable={isDraggable}
                        getSubtaskIcon={getSubtaskIcon}
                        canModifySubtask={canModifySubtask}
                        handleSkipSubtask={handleSkipSubtask}
                        handleDeleteSubtask={handleDeleteSubtask}
                        isSkipping={isSkipping}
                        isDeleting={isDeleting}
                      />
                    );
                  })}
                </div>
              </SortableContext>
            </DndContext>
          ) : (
            <div
              className="rounded-lg p-4 font-mono text-xs"
              style={{
                background: 'var(--color-terminal-background)',
                color: 'var(--color-terminal-text)',
                minHeight: '100%',
              }}
            >
                {currentSubtask ? (
                  <div>
                    <div className="mb-2 pb-2 border-b" style={{ borderColor: 'var(--color-border)' }}>
                      <span style={{ color: 'var(--color-info)' }}>▶ {currentSubtask.activeForm || currentSubtask.label}</span>
                    </div>
                    <div style={{ color: 'var(--color-text-secondary)' }}>
                      [MOCK] Streaming logs will appear here...
                      <br />
                      [MOCK] Reading files...
                      <br />
                      [MOCK] Implementing changes...
                      <br />
                      <span className="animate-pulse">█</span>
                    </div>
                  </div>
                ) : (
                  <div style={{ color: 'var(--color-text-muted)' }}>
                    No active subtask. Logs will appear when a subtask starts executing.
                  </div>
                )}
              </div>
          )}
        </div>

        {/* Footer with progress */}
        <div className="pt-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
          <div className="flex items-center justify-between text-sm">
            <div style={{ color: 'var(--color-text-secondary)' }}>
              Progress: {task.subtasks.filter(s => s.status === 'completed').length}/{task.subtasks.length} completed
            </div>
            <div className="text-lg font-semibold" style={{ color: 'var(--color-info)' }}>
              {Math.round((task.subtasks.filter(s => s.status === 'completed').length / task.subtasks.length) * 100)}%
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
