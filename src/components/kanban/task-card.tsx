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
import { Play, Pause } from 'lucide-react';
import { QAStepperModal } from '@/components/tasks/qa-stepper-modal';
import { PlanReviewModal } from '@/components/tasks/plan-review-modal';

interface TaskCardProps {
  task: Task;
}

export function TaskCard({ task }: TaskCardProps) {
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [showQAModal, setShowQAModal] = useState(false);
  const [showPlanReviewModal, setShowPlanReviewModal] = useState(false);

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
      const response = await fetch('/api/agents/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: task.id,
          prompt: `Work on task: ${task.title}\n\nDescription: ${task.description}`,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        alert(error.error || 'Failed to start agent');
      } else {
        // Reload page to see updated task with agent
        window.location.reload();
      }
    } catch (error) {
      alert('Failed to start agent');
    } finally {
      setIsStarting(false);
    }
  };

  const handleStopAgent = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!task.assignedAgent) return;

    setIsStopping(true);
    try {
      const response = await fetch('/api/agents/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: task.assignedAgent }),
      });

      if (!response.ok) {
        const error = await response.json();
        alert(error.error || 'Failed to stop agent');
      } else {
        window.location.reload();
      }
    } catch (error) {
      alert('Failed to stop agent');
    } finally {
      setIsStopping(false);
    }
  };

  const handleStartPlanning = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsStarting(true);
    try {
      const response = await fetch('/api/agents/start-planning', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id }),
      });

      if (!response.ok) {
        const error = await response.json();
        alert(error.error || 'Failed to start planning');
      } else {
        window.location.reload();
      }
    } catch (error) {
      alert('Failed to start planning');
    } finally {
      setIsStarting(false);
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
      const response = await fetch('/api/agents/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: task.id,
          prompt: `Work on task: ${task.title}\n\nDescription: ${task.description}`,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        alert(error.error || 'Failed to start development');
      } else {
        window.location.reload();
      }
    } catch (error) {
      alert('Failed to start development');
    } finally {
      setIsStarting(false);
    }
  };

  return (
    <Card
      ref={setNodeRef}
      style={{
        ...style,
        background: 'var(--color-surface)',
        borderColor: 'var(--color-border)',
      }}
      {...listeners}
      {...attributes}
      data-testid={`task-card-${task.id}`}
      className="cursor-grab active:cursor-grabbing hover:shadow-lg transition-shadow"
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--color-border-hover)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--color-border)';
      }}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle data-testid="task-title" className="text-sm font-medium line-clamp-2" style={{ color: 'var(--color-text-primary)' }}>
            {task.title}
          </CardTitle>
          <Badge
            data-testid="task-status"
            className="whitespace-nowrap shrink-0"
            style={{
              background: getStatusColors(task.status).bg,
              color: getStatusColors(task.status).text,
            }}
          >
            {task.status.replace('_', ' ')}
          </Badge>
        </div>
        {task.description && (
          <CardDescription data-testid="task-description" className="line-clamp-2 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
            {task.description}
          </CardDescription>
        )}
      </CardHeader>

      <CardContent className="pt-0 space-y-2">
        {task.subtasks.length > 0 && (
          <div data-testid="task-subtasks" className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span style={{ color: 'var(--color-text-muted)' }}>Progress</span>
              <span style={{ color: 'var(--color-text-secondary)' }} className="font-medium">
                {Math.round((task.subtasks.filter((s) => s.status === 'completed').length / task.subtasks.length) * 100)}%
              </span>
            </div>
            {/* Progress dots */}
            <div className="flex gap-1">
              {task.subtasks.map((subtask, idx) => (
                <div
                  key={subtask.id}
                  className="w-2 h-2 rounded-full"
                  style={{
                    background:
                      subtask.status === 'completed'
                        ? 'var(--color-success)'
                        : subtask.status === 'in_progress'
                        ? 'var(--color-info)'
                        : 'var(--color-border)',
                    animation: subtask.status === 'in_progress' ? 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite' : undefined,
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
            {task.planningStatus === 'not_started' && !task.assignedAgent ? (
              <Button
                data-testid="start-planning-button"
                size="sm"
                variant="outline"
                onClick={handleStartPlanning}
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
                <Play className="w-3 h-3" />
                {isStarting ? 'Starting...' : 'Start Planning'}
              </Button>
            ) : task.status === 'planning' && task.assignedAgent ? (
              <div className="flex items-center gap-2">
                <div data-testid="planning-status" className="text-xs flex-1" style={{ color: 'var(--color-info)' }}>
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
                  <Pause className="w-3 h-3" />
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
            ) : task.planningStatus === 'plan_ready' && task.requiresHumanReview && !task.planApproved ? (
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
            ) : task.planApproved ? (
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
                <Play className="w-3 h-3" />
                {isStarting ? 'Starting...' : 'Start Development'}
              </Button>
            ) : null}
          </>
        ) : (
          /* In Progress / Other Phases - Original Agent Buttons */
          <>
            {task.assignedAgent ? (
              <div className="flex items-center gap-2">
                <div data-testid="agent-status" className="text-xs flex-1" style={{ color: 'var(--color-agent-active)' }}>
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
                  <Pause className="w-3 h-3" />
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
                <Play className="w-3 h-3" />
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
    </Card>
  );
}
