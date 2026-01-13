'use client';

/**
 * Task Detail Page
 *
 * Shows task details and agent terminal (if agent is assigned)
 */

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Task } from '@/lib/tasks/schema';
import { AgentTerminal } from '@/components/agents/terminal';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft } from 'lucide-react';

export default function TaskDetailPage() {
  const params = useParams();
  const router = useRouter();
  const taskId = params.id as string;

  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadTask() {
      try {
        const response = await fetch('/api/tasks/list');
        const tasks = await response.json();
        const foundTask = tasks.find((t: Task) => t.id === taskId);
        setTask(foundTask || null);
      } catch (error) {
        console.error('Failed to load task:', error);
      } finally {
        setLoading(false);
      }
    }

    loadTask();
  }, [taskId]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Task not found</h1>
          <Button onClick={() => router.push('/')}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Kanban
          </Button>
        </div>
      </div>
    );
  }

  const statusColors = {
    pending: 'bg-gray-100 text-gray-800',
    in_progress: 'bg-blue-100 text-blue-800',
    completed: 'bg-green-100 text-green-800',
    blocked: 'bg-red-100 text-red-800',
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <Button
          variant="ghost"
          onClick={() => router.push('/')}
          className="mb-4"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Kanban
        </Button>
        <h1 className="text-2xl font-bold text-gray-900">{task.title}</h1>
        <div className="flex items-center gap-2 mt-2">
          <Badge className={statusColors[task.status]}>
            {task.status.replace('_', ' ')}
          </Badge>
          <Badge variant="outline">{task.phase}</Badge>
        </div>
      </div>

      {/* Content */}
      <div className="p-6 space-y-6">
        {/* Task Details */}
        <Card>
          <CardHeader>
            <CardTitle>Task Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <h3 className="font-medium text-sm text-gray-700 mb-1">Description</h3>
              <p className="text-gray-600">{task.description || 'No description'}</p>
            </div>

            {task.subtasks.length > 0 && (
              <div>
                <h3 className="font-medium text-sm text-gray-700 mb-2">
                  Subtasks ({task.subtasks.filter(s => s.status === 'completed').length}/{task.subtasks.length})
                </h3>
                <ul className="space-y-1">
                  {task.subtasks.map((subtask) => (
                    <li key={subtask.id} className="flex items-center gap-2 text-sm">
                      <span className={subtask.status === 'completed' ? 'text-green-600' : 'text-gray-500'}>
                        {subtask.status === 'completed' ? '✓' : '○'}
                      </span>
                      <span className={subtask.status === 'completed' ? 'line-through text-gray-500' : ''}>
                        {subtask.content}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4 pt-4 border-t">
              <div>
                <h3 className="font-medium text-sm text-gray-700">Created</h3>
                <p className="text-sm text-gray-600">
                  {new Date(task.createdAt).toLocaleString()}
                </p>
              </div>
              <div>
                <h3 className="font-medium text-sm text-gray-700">Updated</h3>
                <p className="text-sm text-gray-600">
                  {new Date(task.updatedAt).toLocaleString()}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Agent Terminal */}
        {task.assignedAgent && (
          <div>
            <h2 className="text-xl font-bold text-gray-900 mb-4">Agent Terminal</h2>
            <AgentTerminal threadId={task.assignedAgent} />
          </div>
        )}

        {!task.assignedAgent && (
          <Card>
            <CardHeader>
              <CardTitle>No Agent Assigned</CardTitle>
              <CardDescription>
                Start an agent from the Kanban board to see real-time progress here.
              </CardDescription>
            </CardHeader>
          </Card>
        )}
      </div>
    </div>
  );
}
