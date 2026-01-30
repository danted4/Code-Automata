'use client';

/**
 * Task Detail Modal
 *
 * Shows task subtasks and logs in tabbed interface
 */

import { useMemo, useRef, useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Task, Subtask } from '@/lib/tasks/schema';
import { CheckCircle2, Circle, Loader2, Trash2, SkipForward, GripVertical } from 'lucide-react';
import { toast } from 'sonner';
import { useTaskStore } from '@/store/task-store';
import { Button } from '@/components/ui/button';
import { AgentLog } from '@/lib/agents/manager';
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
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: subtask.id,
    disabled: !isDraggable,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    background:
      subtask.status === 'in_progress' ? 'var(--color-surface-hover)' : 'var(--color-surface)',
    borderColor: subtask.status === 'in_progress' ? 'var(--color-info)' : 'var(--color-border)',
  };

  return (
    <div ref={setNodeRef} style={style} className="flex items-start gap-3 p-3 rounded-lg border">
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
          <GripVertical className="w-5 h-5" style={{ color: 'var(--color-text-muted)' }} />
        </div>
      )}

      {/* Icon */}
      <div className="mt-0.5">{getSubtaskIcon(subtask)}</div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="font-medium text-sm" style={{ color: 'var(--color-text-primary)' }}>
            {index + 1}. {subtask.label}
          </div>
          <div
            className="text-xs px-2 py-0.5 rounded"
            style={{
              background:
                subtask.status === 'completed'
                  ? 'var(--color-success)'
                  : subtask.status === 'in_progress'
                    ? 'var(--color-info)'
                    : 'var(--color-surface-hover)',
              color: subtask.status === 'pending' ? 'var(--color-text-secondary)' : '#ffffff',
            }}
          >
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
  const [isDeleting, setIsDeleting] = useState<string | null>(null);
  const [isSkipping, setIsSkipping] = useState<string | null>(null);
  const [isSkippingCurrent, setIsSkippingCurrent] = useState(false);
  const [subtasks, setSubtasks] = useState<Subtask[]>(task.subtasks);
  const [agentLogs, setAgentLogs] = useState<AgentLog[]>([]);
  const [logStatus, setLogStatus] = useState<
    'idle' | 'connecting' | 'running' | 'completed' | 'stopped' | 'error'
  >('idle');
  const logsEndRef = useRef<HTMLDivElement>(null);
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
  const currentSubtask = task.subtasks.find((s) => s.status === 'in_progress');
  const activeThreadId = task.assignedAgent;

  // Auto-switch to logs tab when a subtask is in progress
  useEffect(() => {
    if (currentSubtask && activeTab === 'subtasks') {
      // Don't auto-switch if user explicitly selected subtasks tab
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSubtask]);

  useEffect(() => {
    if (!open) return;
    if (activeTab !== 'logs') return;

    setAgentLogs([]);

    if (!activeThreadId) {
      setLogStatus('idle');
      return;
    }

    setLogStatus('connecting');

    const eventSource = new EventSource(`/api/agents/stream?threadId=${activeThreadId}`);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'connected') {
          setLogStatus('running');
          return;
        }
        if (data.type === 'status') {
          // completed | error | stopped
          setLogStatus(data.status || 'completed');
          eventSource.close();
          return;
        }

        setAgentLogs((prev) => [...prev, data]);
      } catch (error) {
        console.error('Failed to parse SSE message:', error);
      }
    };

    eventSource.onerror = () => {
      setLogStatus('error');
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  }, [open, activeTab, activeThreadId]);

  useEffect(() => {
    if (activeTab !== 'logs') return;
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [agentLogs, activeTab]);

  const statusColor = useMemo(() => {
    switch (logStatus) {
      case 'running':
        return 'var(--color-info)';
      case 'completed':
        return 'var(--color-success)';
      case 'error':
        return 'var(--color-error)';
      case 'stopped':
        return 'var(--color-warning)';
      default:
        return 'var(--color-text-muted)';
    }
  }, [logStatus]);

  const formatTimestamp = (timestamp: number) => new Date(timestamp).toLocaleTimeString();

  const logsText = useMemo(() => {
    const lines = agentLogs.map((log) => {
      const content =
        typeof log.content === 'string' ? log.content : JSON.stringify(log.content, null, 2);
      return `[${formatTimestamp(log.timestamp)}] ${log.type}: ${content}`;
    });
    return [
      `Task: ${task.title}`,
      `Phase: ${task.phase}`,
      `Thread: ${activeThreadId || '—'}`,
      `Status: ${logStatus}`,
      '',
      ...lines,
    ].join('\n');
  }, [agentLogs, logStatus, task.phase, task.title, activeThreadId]);

  const handleCopyLogs = async () => {
    try {
      await navigator.clipboard.writeText(logsText);
      toast.success('Copied logs to clipboard');
    } catch (e) {
      toast.error('Failed to copy logs');
      console.error(e);
    }
  };

  const handleDeleteSubtask = async (subtaskId: string) => {
    setIsDeleting(subtaskId);

    // Optimistic update - remove immediately from local state
    const originalSubtasks = [...subtasks];
    setSubtasks((prev) => prev.filter((s) => s.id !== subtaskId));

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
    setSubtasks((prev) =>
      prev.map((s) => (s.id === subtaskId ? { ...s, status: 'completed' as const } : s))
    );

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

  const handleSkipCurrentSubtask = async () => {
    if (!currentSubtask) return;
    setIsSkippingCurrent(true);
    try {
      const response = await fetch('/api/tasks/skip-subtask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: task.id,
          subtaskId: currentSubtask.id,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        toast.error(error.error || 'Failed to skip current subtask');
        return;
      }

      toast.success(`Skipped: ${currentSubtask.label}`);
      await loadTasks();
    } catch (error) {
      toast.error('Failed to skip current subtask');
      console.error(error);
    } finally {
      setIsSkippingCurrent(false);
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

  const canModifySubtask = (subtask: Subtask, _index: number) => {
    // In progress phase: can modify dev subtasks
    if (task.phase === 'in_progress') {
      if (subtask.type !== 'dev') return false;

      const inProgressIndex = task.subtasks
        .filter((s) => s.type === 'dev')
        .findIndex((s) => s.status === 'in_progress');

      // If there's an in_progress subtask, only allow modifying pending ones that come AFTER it
      if (inProgressIndex !== -1) {
        const devSubtasks = task.subtasks.filter((s) => s.type === 'dev');
        return subtask.status === 'pending' && devSubtasks.indexOf(subtask) > inProgressIndex;
      }

      return subtask.status === 'pending';
    }

    // AI review phase: can modify QA subtasks
    if (task.phase === 'ai_review') {
      if (subtask.type !== 'qa') return false;

      const inProgressIndex = task.subtasks
        .filter((s) => s.type === 'qa')
        .findIndex((s) => s.status === 'in_progress');

      if (inProgressIndex !== -1) {
        const qaSubtasks = task.subtasks.filter((s) => s.type === 'qa');
        return subtask.status === 'pending' && qaSubtasks.indexOf(subtask) > inProgressIndex;
      }

      return subtask.status === 'pending';
    }

    return false;
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
          subtaskIds: reorderedSubtasks.map((s) => s.id),
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
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onDragStart={(e) => e.stopPropagation()}
        onDrag={(e) => e.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>{task.title || task.id}</DialogTitle>
          <DialogDescription>{task.description}</DialogDescription>
        </DialogHeader>

        {/* Tabs */}
        <div
          className="flex gap-1 border-b"
          style={{ borderColor: 'var(--color-border)' }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              setActiveTab('subtasks');
            }}
            className="px-4 py-2 text-sm font-medium transition-all relative"
            style={{
              color:
                activeTab === 'subtasks' ? 'var(--color-primary)' : 'var(--color-text-secondary)',
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
            onClick={(e) => {
              e.stopPropagation();
              setActiveTab('logs');
            }}
            className="px-4 py-2 text-sm font-medium transition-all relative"
            style={{
              color: activeTab === 'logs' ? 'var(--color-primary)' : 'var(--color-text-secondary)',
            }}
          >
            Logs
            {currentSubtask && activeTab === 'logs' && (
              <Loader2
                className="w-3 h-3 ml-1 inline animate-spin"
                style={{ color: 'var(--color-info)' }}
              />
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
        <div
          className="flex-1 overflow-y-auto py-4 px-2"
          style={{ minHeight: '500px', maxHeight: '500px' }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onDragStart={(e) => e.stopPropagation()}
          onDrag={(e) => e.stopPropagation()}
        >
          {activeTab === 'subtasks' ? (
            <>
              {task.phase === 'in_progress' ? (
                <>
                  {/* DEV SUBTASKS SECTION */}
                  <div className="mb-6">
                    <h3
                      className="text-sm font-semibold mb-3"
                      style={{ color: 'var(--color-text-primary)' }}
                    >
                      Development Tasks
                    </h3>
                    <DndContext
                      sensors={sensors}
                      collisionDetection={closestCenter}
                      onDragEnd={handleDragEnd}
                    >
                      <SortableContext
                        items={subtasks.filter((s) => s.type === 'dev').map((s) => s.id)}
                        strategy={verticalListSortingStrategy}
                      >
                        <div className="space-y-3">
                          {subtasks
                            .filter((s) => s.type === 'dev')
                            .map((subtask, index) => {
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
                  </div>

                  {/* UPCOMING QA TASKS (Read-only) */}
                  {task.phase === 'in_progress' && subtasks.some((s) => s.type === 'qa') && (
                    <div
                      className="border-t pt-4"
                      style={{
                        borderColor: 'var(--color-border)',
                      }}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onDragStart={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onDrag={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                    >
                      <h3
                        className="text-sm font-semibold mb-3"
                        style={{ color: 'var(--color-text-secondary)' }}
                      >
                        📋 Upcoming QA Tasks
                      </h3>
                      <div className="space-y-3 opacity-60">
                        {subtasks
                          .filter((s) => s.type === 'qa')
                          .map((subtask, index) => (
                            <div
                              key={subtask.id}
                              className="flex items-start gap-3 p-3 rounded-lg border"
                              style={{
                                background: 'var(--color-surface)',
                                borderColor: 'var(--color-border)',
                              }}
                              onMouseDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                              }}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                              }}
                              onPointerDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                              }}
                            >
                              <div className="mt-0.5">{getSubtaskIcon(subtask)}</div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-start justify-between gap-2">
                                  <div
                                    className="font-medium text-sm"
                                    style={{ color: 'var(--color-text-primary)' }}
                                  >
                                    {index + 1}. {subtask.label}
                                  </div>
                                  <div
                                    className="text-xs px-2 py-0.5 rounded"
                                    style={{
                                      background: 'var(--color-surface-hover)',
                                      color: 'var(--color-text-secondary)',
                                    }}
                                  >
                                    Pending QA
                                  </div>
                                </div>
                                <div
                                  className="mt-1 text-xs"
                                  style={{ color: 'var(--color-text-secondary)' }}
                                >
                                  {subtask.content}
                                </div>
                              </div>
                            </div>
                          ))}
                      </div>
                    </div>
                  )}
                </>
              ) : task.phase === 'ai_review' ? (
                <>
                  {/* QA SUBTASKS SECTION */}
                  <div className="mb-6">
                    <h3
                      className="text-sm font-semibold mb-3"
                      style={{ color: 'var(--color-text-primary)' }}
                    >
                      QA Verification Tasks
                    </h3>
                    <DndContext
                      sensors={sensors}
                      collisionDetection={closestCenter}
                      onDragEnd={handleDragEnd}
                    >
                      <SortableContext
                        items={subtasks.filter((s) => s.type === 'qa').map((s) => s.id)}
                        strategy={verticalListSortingStrategy}
                      >
                        <div className="space-y-3">
                          {subtasks
                            .filter((s) => s.type === 'qa')
                            .map((subtask, index) => {
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
                  </div>

                  {/* WHAT WAS DEVELOPED (Read-only) */}
                  {subtasks.some((s) => s.type === 'dev') && (
                    <div
                      className="border-t pt-4"
                      style={{
                        borderColor: 'var(--color-border)',
                      }}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onDragStart={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onDrag={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                    >
                      <h3
                        className="text-sm font-semibold mb-3"
                        style={{ color: 'var(--color-text-secondary)' }}
                      >
                        ✅ What Was Developed
                      </h3>
                      <div className="space-y-3 opacity-60">
                        {subtasks
                          .filter((s) => s.type === 'dev')
                          .map((subtask, index) => (
                            <div
                              key={subtask.id}
                              className="flex items-start gap-3 p-3 rounded-lg border"
                              style={{
                                background: 'var(--color-surface)',
                                borderColor: 'var(--color-border)',
                              }}
                              onMouseDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                              }}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                              }}
                              onPointerDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                              }}
                            >
                              <div className="mt-0.5">{getSubtaskIcon(subtask)}</div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-start justify-between gap-2">
                                  <div
                                    className="font-medium text-sm"
                                    style={{ color: 'var(--color-text-primary)' }}
                                  >
                                    {index + 1}. {subtask.label}
                                  </div>
                                  <div
                                    className="text-xs px-2 py-0.5 rounded"
                                    style={{
                                      background: 'var(--color-surface-hover)',
                                      color: 'var(--color-text-secondary)',
                                    }}
                                  >
                                    {subtask.status.replace('_', ' ')}
                                  </div>
                                </div>
                                <div
                                  className="mt-1 text-xs"
                                  style={{ color: 'var(--color-text-secondary)' }}
                                >
                                  {subtask.content}
                                </div>
                              </div>
                            </div>
                          ))}
                      </div>
                    </div>
                  )}
                </>
              ) : task.phase === 'done' ? (
                <>
                  <div className="mb-6">
                    <h3
                      className="text-sm font-semibold mb-3"
                      style={{ color: 'var(--color-text-primary)' }}
                    >
                      ✅ What was completed
                    </h3>

                    <div className="space-y-3">
                      {[...subtasks]
                        .sort((a, b) => {
                          // Dev first, then QA. Keep stable-ish order by id.
                          if (a.type !== b.type) return a.type === 'dev' ? -1 : 1;
                          return a.id.localeCompare(b.id);
                        })
                        .map((subtask, index) => (
                          <div
                            key={subtask.id}
                            className="flex items-start gap-3 p-3 rounded-lg border"
                            style={{
                              background: 'var(--color-surface)',
                              borderColor: 'var(--color-border)',
                            }}
                          >
                            <div className="mt-0.5">{getSubtaskIcon(subtask)}</div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-start justify-between gap-2">
                                <div
                                  className="font-medium text-sm"
                                  style={{ color: 'var(--color-text-primary)' }}
                                >
                                  {index + 1}. {subtask.label}
                                </div>
                                <div className="flex items-center gap-2">
                                  <div
                                    className="text-xs px-2 py-0.5 rounded"
                                    style={{
                                      background:
                                        subtask.type === 'qa' ? '#a78bfa' : 'var(--color-success)',
                                      color: '#ffffff',
                                    }}
                                    title={subtask.type === 'qa' ? 'QA' : 'Dev'}
                                  >
                                    {subtask.type.toUpperCase()}
                                  </div>
                                  <div
                                    className="text-xs px-2 py-0.5 rounded"
                                    style={{
                                      background: 'var(--color-surface-hover)',
                                      color: 'var(--color-text-secondary)',
                                    }}
                                  >
                                    {subtask.status.replace('_', ' ')}
                                  </div>
                                </div>
                              </div>
                              <div
                                className="mt-1 text-xs"
                                style={{ color: 'var(--color-text-secondary)' }}
                              >
                                {subtask.content}
                              </div>
                            </div>
                          </div>
                        ))}
                    </div>
                  </div>
                </>
              ) : null}
            </>
          ) : (
            <div
              className="rounded-lg p-4"
              style={{
                background: 'var(--color-terminal-background)',
                color: 'var(--color-terminal-text)',
                minHeight: '100%',
              }}
              // dnd-kit listens to pointer events; keep them inside the modal.
              onPointerDownCapture={(e) => e.stopPropagation()}
              onPointerMoveCapture={(e) => e.stopPropagation()}
              onPointerUpCapture={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div
                className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
                style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                onPointerDownCapture={(e) => e.stopPropagation()}
              >
                <div className="text-xs font-mono" style={{ color: 'var(--color-text-muted)' }}>
                  Thread: {activeThreadId || '—'}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCopyLogs();
                    }}
                    disabled={!agentLogs.length}
                    title={!agentLogs.length ? 'No logs to copy yet' : 'Copy logs to clipboard'}
                    style={{
                      background: 'var(--color-surface)',
                      color: 'var(--color-text-primary)',
                      borderColor: 'var(--color-border)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--color-surface-hover)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'var(--color-surface)';
                    }}
                  >
                    Copy logs
                  </Button>
                  <div className="text-xs font-medium" style={{ color: statusColor }}>
                    ● {logStatus.toUpperCase()}
                  </div>
                </div>
              </div>

              {/* Terminal body */}
              <div className="mt-3 h-[420px] overflow-y-auto font-mono text-xs whitespace-pre-wrap break-words">
                {!activeThreadId ? (
                  <div style={{ color: 'var(--color-text-muted)' }}>
                    No active agent thread. Logs will appear when a subtask starts executing.
                  </div>
                ) : agentLogs.length === 0 && logStatus === 'connecting' ? (
                  <div style={{ color: 'var(--color-text-muted)' }}>Connecting to agent…</div>
                ) : (
                  <>
                    {currentSubtask && (
                      <div
                        className="mb-2 pb-2 border-b"
                        style={{ borderColor: 'var(--color-border)' }}
                      >
                        <span style={{ color: 'var(--color-info)' }}>
                          ▶ {currentSubtask.activeForm || currentSubtask.label}
                        </span>
                      </div>
                    )}
                    {agentLogs.map((log, i) => (
                      <div key={i} className="mb-2">
                        <span style={{ color: 'var(--color-text-muted)' }}>
                          [{formatTimestamp(log.timestamp)}]
                        </span>{' '}
                        <span style={{ color: 'var(--color-info)' }}>{log.type}:</span>{' '}
                        <span style={{ color: 'var(--color-terminal-text)' }}>
                          {typeof log.content === 'string'
                            ? log.content
                            : JSON.stringify(log.content, null, 2)}
                        </span>
                      </div>
                    ))}
                    <div ref={logsEndRef} />
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer with progress */}
        <div className="pt-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
          <div className="flex items-center justify-between text-sm gap-3">
            <div style={{ color: 'var(--color-text-secondary)' }}>
              Progress:{' '}
              {(() => {
                const relevantSubtasks =
                  task.phase === 'in_progress'
                    ? task.subtasks.filter((s) => s.type === 'dev')
                    : task.phase === 'ai_review'
                      ? task.subtasks.filter((s) => s.type === 'qa')
                      : task.subtasks;
                return `${relevantSubtasks.filter((s) => s.status === 'completed').length}/${relevantSubtasks.length} completed`;
              })()}
            </div>
            {currentSubtask && (
              <button
                onClick={handleSkipCurrentSubtask}
                disabled={isSkippingCurrent}
                className="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                style={{
                  background: 'var(--color-warning)',
                  color: '#000000',
                  opacity: isSkippingCurrent ? 0.6 : 1,
                  whiteSpace: 'nowrap',
                }}
                title="Skip the currently running subtask (stops the agent)"
              >
                {isSkippingCurrent ? 'Skipping…' : 'Skip current'}
              </button>
            )}
            <div className="text-lg font-semibold" style={{ color: 'var(--color-info)' }}>
              {(() => {
                const relevantSubtasks =
                  task.phase === 'in_progress'
                    ? task.subtasks.filter((s) => s.type === 'dev')
                    : task.phase === 'ai_review'
                      ? task.subtasks.filter((s) => s.type === 'qa')
                      : task.subtasks;
                return Math.round(
                  (relevantSubtasks.filter((s) => s.status === 'completed').length /
                    (relevantSubtasks.length || 1)) *
                    100
                );
              })()}
              %
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
