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
import { Play, Square } from 'lucide-react';

interface TaskCardProps {
  task: Task;
}

export function TaskCard({ task }: TaskCardProps) {
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
  });

  const style = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
        opacity: isDragging ? 0.5 : 1,
      }
    : undefined;

  const statusColors = {
    pending: 'bg-gray-100 text-gray-800',
    in_progress: 'bg-blue-100 text-blue-800',
    completed: 'bg-green-100 text-green-800',
    blocked: 'bg-red-100 text-red-800',
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

  return (
    <Card
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className="cursor-grab active:cursor-grabbing hover:shadow-md transition-shadow"
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base font-medium line-clamp-2">
            {task.title}
          </CardTitle>
          <Badge className={statusColors[task.status]}>
            {task.status.replace('_', ' ')}
          </Badge>
        </div>
        {task.description && (
          <CardDescription className="line-clamp-2 text-sm">
            {task.description}
          </CardDescription>
        )}
      </CardHeader>

      <CardContent className="pt-0 space-y-2">
        {task.subtasks.length > 0 && (
          <div className="text-xs text-gray-500">
            {task.subtasks.filter((s) => s.status === 'completed').length} /{' '}
            {task.subtasks.length} subtasks
          </div>
        )}

        {task.assignedAgent ? (
          <div className="flex items-center gap-2">
            <div className="text-xs text-blue-600 flex-1">
              🤖 Agent working
            </div>
            <Button
              size="sm"
              variant="destructive"
              onClick={handleStopAgent}
              disabled={isStopping}
            >
              <Square className="w-3 h-3" />
              {isStopping ? 'Stopping...' : 'Stop'}
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={handleStartAgent}
            disabled={isStarting}
            className="w-full"
          >
            <Play className="w-3 h-3" />
            {isStarting ? 'Starting...' : 'Start Agent'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
