'use client';

/**
 * Task Card Component
 *
 * Draggable task card for the Kanban board
 */

import { useDraggable } from '@dnd-kit/core';
import { useState } from 'react';
import { Task } from '@/lib/tasks/schema';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Play, PauseCircle, GitBranch, Trash2 } from 'lucide-react';
import { QAStepperModal } from '@/components/tasks/qa-stepper-modal';
import { PlanReviewModal } from '@/components/tasks/plan-review-modal';
import { TaskDetailModal } from '@/components/tasks/task-detail-modal';
import { HumanReviewModal } from '@/components/tasks/human-review-modal';
import { PlanningLogsModal } from '@/components/tasks/planning-logs-modal';
import { DeleteTaskModal } from '@/components/tasks/delete-task-modal';
import { toast } from 'sonner';
import { useTaskStore } from '@/store/task-store';
import { apiFetch } from '@/lib/api-client';

interface TaskCardProps {
  task: Task;
  onEditBlockedTask?: (task: Task | null) => void;
}

export function TaskCard({ task, onEditBlockedTask }: TaskCardProps) {
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isStartingReview, setIsStartingReview] = useState(false);
  const [showQAModal, setShowQAModal] = useState(false);
  const [showPlanReviewModal, setShowPlanReviewModal] = useState(false);
  const [showTaskDetailModal, setShowTaskDetailModal] = useState(false);
  const [showHumanReviewModal, setShowHumanReviewModal] = useState(false);
  const [showPlanningLogsModal, setShowPlanningLogsModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isModalClosing, setIsModalClosing] = useState(false);
  const { loadTasks } = useTaskStore();

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
  });

  const style = {
    opacity: isDragging ? 0.3 : 1,
  };

  const getStatusColors = (status: Task['status']) => {
    const colors = {
      pending: { bg: 'var(--color-status-pending)', text: '#000000' },
      in_progress: { bg: 'var(--color-status-in-progress)', text: '#ffffff' },
      completed: { bg: 'var(--color-status-completed)', text: '#ffffff' },
      blocked: { bg: 'var(--color-status-blocked)', text: '#ffffff' },
      planning: { bg: 'var(--color-info)', text: '#ffffff' },
    };
    return colors[status] || colors.pending;
  };

  const handleStartAgent = async (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent drag when clicking button
    setIsStarting(true);
    try {
      const response = await apiFetch('/api/agents/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: task.id,
          prompt: `Work on task: ${task.title}\n\nDescription: ${task.description}`,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        toast.error(error.error || 'Failed to start agent');
      } else {
        toast.success('Agent started successfully');
        await loadTasks();
      }
    } catch (_error) {
      toast.error('Failed to start agent');
    } finally {
      setIsStarting(false);
    }
  };

  const handleStopAgent = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!task.assignedAgent) return;

    setIsStopping(true);
    try {
      const response = await apiFetch('/api/agents/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: task.assignedAgent }),
      });

      if (!response.ok) {
        const error = await response.json();
        toast.error(error.error || 'Failed to stop agent');
      } else {
        toast.success('Agent stopped successfully');
        await loadTasks();
      }
    } catch (_error) {
      toast.error('Failed to stop agent');
    } finally {
      setIsStopping(false);
    }
  };

  const handleDeleteIconClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setShowDeleteModal(true);
  };

  const handleDeleteTask = async () => {
    setIsDeleting(true);
    try {
      const response = await apiFetch(`/api/tasks/delete?taskId=${task.id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const error = await response.json();
        toast.error(error.error || 'Failed to delete task');
      } else {
        toast.success('Task deleted successfully');
        setShowDeleteModal(false);
        await loadTasks();
      }
    } catch (_error) {
      toast.error('Failed to delete task');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleAnswerQuestions = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowQAModal(true);
  };

  const handleReviewPlan = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowPlanReviewModal(true);
  };

  const handleStartDevelopment = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsStarting(true);
    try {
      const response = await apiFetch('/api/agents/start-development', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id }),
      });

      if (!response.ok) {
        const error = await response.json();
        toast.error(error.error || 'Failed to start development');
      } else {
        toast.success('Development started successfully');
        await loadTasks();
      }
    } catch (_error) {
      toast.error('Failed to start development');
    } finally {
      setIsStarting(false);
    }
  };

  const handleStartReview = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsStartingReview(true);
    try {
      const response = await apiFetch('/api/agents/start-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id }),
      });

      if (!response.ok) {
        const error = await response.json();
        toast.error(error.error || 'Failed to start AI review');
      } else {
        toast.success('AI review started');
        await loadTasks();
      }
    } catch (_error) {
      toast.error('Failed to start AI review');
    } finally {
      setIsStartingReview(false);
    }
  };

  const handleCardClick = (_e: React.MouseEvent) => {
    // Prevent opening if modal is currently closing (prevents event propagation issues)
    if (isModalClosing) {
      return;
    }

    // Prevent opening if delete modal is open
    if (showDeleteModal) {
      return;
    }

    // Planning mode: open edit modal when task is blocked (user can modify and restart)
    if (task.phase === 'planning' && task.status === 'blocked') {
      onEditBlockedTask?.(task);
      return;
    }

    // Planning mode: open live planning logs when an agent is running
    if (task.phase === 'planning' && task.status === 'planning' && task.assignedAgent) {
      setShowPlanningLogsModal(true);
      return;
    }

    // Open human review modal if task is in human_review phase
    if (task.phase === 'human_review' && task.subtasks && task.subtasks.length > 0) {
      setShowHumanReviewModal(true);
      return;
    }

    // Open detail modal if task has subtasks and is in progress or ai_review phase
    if (
      task.subtasks &&
      task.subtasks.length > 0 &&
      !showTaskDetailModal &&
      (task.phase === 'in_progress' || task.phase === 'ai_review' || task.phase === 'done')
    ) {
      setShowTaskDetailModal(true);
    }
  };

  const handleTaskDetailModalClose = (open: boolean) => {
    if (!open) {
      // Set closing flag to prevent immediate reopening from event propagation
      setIsModalClosing(true);
      setShowTaskDetailModal(false);

      // Clear the flag after a short delay
      setTimeout(() => {
        setIsModalClosing(false);
      }, 300);
    } else {
      setShowTaskDetailModal(true);
    }
  };

  const isClickable =
    (task.phase === 'planning' && task.status === 'blocked') ||
    (task.phase === 'planning' && task.status === 'planning' && !!task.assignedAgent) ||
    (task.subtasks &&
      task.subtasks.length > 0 &&
      (task.phase === 'in_progress' ||
        task.phase === 'ai_review' ||
        task.phase === 'human_review' ||
        task.phase === 'done'));

  return (
    <Card
      ref={setNodeRef}
      style={{
        ...style,
        background: 'var(--color-surface)',
        borderColor: 'var(--color-border)',
        cursor: isClickable ? 'pointer' : undefined,
        position: 'relative',
      }}
      {...listeners}
      {...attributes}
      data-testid={`task-card-${task.id}`}
      className={
        isClickable
          ? 'hover:shadow-lg transition-shadow'
          : 'cursor-grab active:cursor-grabbing hover:shadow-lg transition-shadow'
      }
      onClick={handleCardClick}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--color-border-hover)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--color-border)';
      }}
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
              style={{
                background: getStatusColors(task.status).bg,
                color: getStatusColors(task.status).text,
              }}
            >
              {task.status.replace('_', ' ')}
            </Badge>
            {/* Delete Icon Button */}
            <button
              onClick={handleDeleteIconClick}
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
        {task.branchName && (
          <div className="flex items-center gap-1 mt-2">
            <GitBranch className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
            <span className="text-xs font-mono" style={{ color: 'var(--color-text-muted)' }}>
              {task.branchName}
            </span>
          </div>
        )}
      </CardHeader>

      <CardContent className="pt-0 space-y-2">
        {task.subtasks.length > 0 && (
          <div data-testid="task-subtasks" className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span style={{ color: 'var(--color-text-muted)' }}>
                {task.phase === 'ai_review' ? 'QA Progress' : 'Progress'}
              </span>
              <span style={{ color: 'var(--color-text-secondary)' }} className="font-medium">
                {(() => {
                  const relevantSubtasks =
                    task.phase === 'in_progress'
                      ? task.subtasks.filter((s) => s.type === 'dev')
                      : task.phase === 'ai_review'
                        ? task.subtasks.filter((s) => s.type === 'qa')
                        : task.phase === 'human_review'
                          ? task.subtasks
                          : task.subtasks;
                  return Math.round(
                    (relevantSubtasks.filter((s) => s.status === 'completed').length /
                      (relevantSubtasks.length || 1)) *
                      100
                  );
                })()}
                %
              </span>
            </div>
            {/* Progress dots - filtered by phase */}
            <div className="flex gap-1">
              {task.subtasks
                .filter((subtask) => {
                  // In progress phase: show only dev subtasks
                  // AI review phase: show only QA subtasks
                  // Human review & done: show all subtasks (both dev and QA)
                  if (task.phase === 'in_progress') {
                    return subtask.type === 'dev';
                  } else if (task.phase === 'ai_review') {
                    return subtask.type === 'qa';
                  } else if (task.phase === 'human_review' || task.phase === 'done') {
                    return true; // Show all subtasks
                  }
                  return false;
                })
                .map((subtask, _idx) => (
                  <div
                    key={subtask.id}
                    className="w-2 h-2 rounded-full"
                    style={{
                      background:
                        subtask.status === 'completed'
                          ? subtask.type === 'qa'
                            ? '#a78bfa' // Purple for QA completions
                            : 'var(--color-success)' // Green/Blue for dev completions
                          : subtask.status === 'in_progress'
                            ? 'var(--color-info)'
                            : 'var(--color-border)',
                      animation:
                        subtask.status === 'in_progress'
                          ? 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite'
                          : undefined,
                    }}
                    title={subtask.content}
                  />
                ))}
            </div>
          </div>
        )}

        {/* Planning Phase Buttons */}
        {task.phase === 'planning' ? (
          <>
            {task.status === 'planning' && task.assignedAgent ? (
              <div className="flex items-center gap-2">
                <div
                  data-testid="planning-status"
                  className="text-xs flex-1"
                  style={{ color: 'var(--color-info)' }}
                >
                  🤖 Planning in progress
                </div>
                <Button
                  data-testid="pause-planning-button"
                  size="sm"
                  variant="secondary"
                  onClick={handleStopAgent}
                  disabled={isStopping}
                  className="text-xs"
                  style={{
                    background: 'var(--color-secondary)',
                    color: 'var(--color-secondary-text)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--color-secondary-hover)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'var(--color-secondary)';
                  }}
                >
                  <PauseCircle className="w-4 h-4" />
                  {isStopping ? 'Pausing...' : 'Pause'}
                </Button>
              </div>
            ) : task.planningStatus === 'waiting_for_answers' ? (
              <Button
                data-testid="answer-questions-button"
                size="sm"
                variant="outline"
                onClick={handleAnswerQuestions}
                className="w-full text-xs"
                style={{
                  background: 'var(--color-warning)',
                  color: '#000000',
                  borderColor: 'var(--color-warning)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.opacity = '0.9';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.opacity = '1';
                }}
              >
                ❓ Answer Questions ({task.planningData?.questions?.length || 0})
              </Button>
            ) : task.planningStatus === 'plan_ready' &&
              task.requiresHumanReview &&
              !task.planApproved ? (
              <Button
                data-testid="review-plan-button"
                size="sm"
                variant="outline"
                onClick={handleReviewPlan}
                className="w-full text-xs"
                style={{
                  background: 'var(--color-info)',
                  color: '#ffffff',
                  borderColor: 'var(--color-info)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.opacity = '0.9';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.opacity = '1';
                }}
              >
                📋 Review Plan
              </Button>
            ) : task.planApproved && task.requiresHumanReview ? (
              <Button
                data-testid="start-development-button"
                size="sm"
                variant="outline"
                onClick={handleStartDevelopment}
                disabled={isStarting}
                className="w-full text-xs"
                style={{
                  background: 'var(--color-primary)',
                  color: 'var(--color-primary-text)',
                  borderColor: 'var(--color-primary)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--color-primary-hover)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'var(--color-primary)';
                }}
              >
                <Play className="w-4 h-4" strokeWidth={2.5} />
                {isStarting ? 'Starting...' : 'Start Development'}
              </Button>
            ) : task.planApproved && !task.requiresHumanReview ? (
              // No-human-review tasks auto-start development. If something goes wrong and we stay
              // in planning without subtasks for a while, show a retry button.
              task.subtasks.length === 0 && Date.now() - task.updatedAt > 10_000 ? (
                <Button
                  data-testid="start-development-button"
                  size="sm"
                  variant="outline"
                  onClick={handleStartDevelopment}
                  disabled={isStarting}
                  className="w-full text-xs"
                  style={{
                    background: 'var(--color-primary)',
                    color: 'var(--color-primary-text)',
                    borderColor: 'var(--color-primary)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--color-primary-hover)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'var(--color-primary)';
                  }}
                >
                  <Play className="w-4 h-4" strokeWidth={2.5} />
                  {isStarting ? 'Starting...' : 'Retry Auto-Start'}
                </Button>
              ) : (
                <div
                  className="w-full text-xs py-2 px-3 rounded text-center"
                  style={{
                    background: 'var(--color-surface-hover)',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  🤖 Auto-starting development…
                </div>
              )
            ) : null}
          </>
        ) : task.phase === 'ai_review' ? (
          /* AI Review Phase - QA Subtasks */
          <>
            {task.assignedAgent ? (
              <div className="flex items-center gap-2">
                <div
                  data-testid="review-status"
                  className="text-xs flex-1"
                  style={{ color: 'var(--color-agent-active)' }}
                >
                  🤖 QA review in progress
                </div>
                <Button
                  data-testid="pause-review-button"
                  size="sm"
                  variant="secondary"
                  onClick={handleStopAgent}
                  disabled={isStopping}
                  className="text-xs"
                  style={{
                    background: 'var(--color-secondary)',
                    color: 'var(--color-secondary-text)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--color-secondary-hover)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'var(--color-secondary)';
                  }}
                >
                  <PauseCircle className="w-4 h-4" />
                  {isStopping ? 'Pausing...' : 'Pause'}
                </Button>
              </div>
            ) : Date.now() - task.updatedAt > 15_000 ? (
              // QA didn't start within 15s (manual drag, agent stopped, or auto-trigger failed)
              <Button
                data-testid="retry-ai-review-button"
                size="sm"
                variant="outline"
                onClick={handleStartReview}
                disabled={isStartingReview}
                className="w-full text-xs"
                style={{
                  background: 'var(--color-phase-validate)',
                  color: '#ffffff',
                  borderColor: 'var(--color-phase-validate)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.opacity = '0.9';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.opacity = '1';
                }}
              >
                <Play className="w-4 h-4" strokeWidth={2.5} />
                {isStartingReview ? 'Starting...' : 'Retry AI Review'}
              </Button>
            ) : (
              // QA auto-starts when dev completes. Show Auto-starting for up to 15s.
              <div
                className="w-full text-xs py-2 px-3 rounded text-center"
                style={{
                  background: 'var(--color-surface-hover)',
                  color: 'var(--color-text-secondary)',
                }}
              >
                🤖 Auto-starting QA…
              </div>
            )}
          </>
        ) : task.phase === 'human_review' ? (
          /* Human Review Phase - Review & Approval */
          <>
            <div
              className="w-full text-xs py-2 px-3 rounded text-center"
              style={{ background: 'var(--color-success)', color: '#ffffff' }}
            >
              ✓ Ready for human review
            </div>
          </>
        ) : task.phase === 'done' ? (
          /* Done Phase - Read-only */
          <>
            <div
              className="w-full text-xs py-2 px-3 rounded text-center"
              style={{
                background: 'var(--color-surface-hover)',
                color: 'var(--color-text-secondary)',
              }}
            >
              ✓ Completed
            </div>
          </>
        ) : (
          /* In Progress / Other Phases - Original Agent Buttons */
          <>
            {task.assignedAgent ? (
              <div className="flex items-center gap-2">
                <div
                  data-testid="agent-status"
                  className="text-xs flex-1"
                  style={{ color: 'var(--color-agent-active)' }}
                >
                  🤖 Agent working
                </div>
                <Button
                  data-testid="pause-agent-button"
                  size="sm"
                  variant="secondary"
                  onClick={handleStopAgent}
                  disabled={isStopping}
                  className="text-xs"
                  style={{
                    background: 'var(--color-secondary)',
                    color: 'var(--color-secondary-text)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--color-secondary-hover)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'var(--color-secondary)';
                  }}
                >
                  <PauseCircle className="w-4 h-4" />
                  {isStopping ? 'Pausing...' : 'Pause'}
                </Button>
              </div>
            ) : (
              <Button
                data-testid="start-agent-button"
                size="sm"
                variant="outline"
                onClick={handleStartAgent}
                disabled={isStarting}
                className="w-full text-xs"
                style={{
                  background: 'var(--color-surface-hover)',
                  color: 'var(--color-text-primary)',
                  borderColor: 'var(--color-border)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--color-background)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'var(--color-surface-hover)';
                }}
              >
                <Play className="w-4 h-4" strokeWidth={2.5} />
                {isStarting ? 'Starting...' : 'Start Agent'}
              </Button>
            )}
          </>
        )}
      </CardContent>

      {/* Q&A Modal */}
      {task.planningData?.questions && (
        <QAStepperModal
          open={showQAModal}
          onOpenChange={setShowQAModal}
          taskId={task.id}
          questions={task.planningData.questions}
        />
      )}

      {/* Plan Review Modal */}
      {task.planContent && (
        <PlanReviewModal
          open={showPlanReviewModal}
          onOpenChange={setShowPlanReviewModal}
          taskId={task.id}
          planContent={task.planContent}
          taskTitle={task.title}
        />
      )}

      {/* Task Detail Modal (Subtasks & Logs) */}
      {task.subtasks && task.subtasks.length > 0 && (
        <TaskDetailModal
          open={showTaskDetailModal}
          onOpenChange={handleTaskDetailModalClose}
          task={task}
        />
      )}

      {/* Human Review Modal */}
      {task.subtasks && task.subtasks.length > 0 && (
        <HumanReviewModal
          open={showHumanReviewModal}
          onOpenChange={setShowHumanReviewModal}
          task={task}
        />
      )}

      {/* Planning Logs Modal */}
      {task.phase === 'planning' && task.status === 'planning' && task.assignedAgent && (
        <PlanningLogsModal
          open={showPlanningLogsModal}
          onOpenChange={setShowPlanningLogsModal}
          taskTitle={task.title}
          threadId={task.assignedAgent}
        />
      )}

      {/* Delete Task Modal */}
      <DeleteTaskModal
        open={showDeleteModal}
        onOpenChange={setShowDeleteModal}
        task={task}
        onConfirmDelete={handleDeleteTask}
        isDeleting={isDeleting}
      />
    </Card>
  );
}
