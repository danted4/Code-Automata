/**
 * Delete Subtask API Route
 *
 * Removes a subtask from the task
 */

import { NextRequest, NextResponse } from 'next/server';
import { taskPersistence } from '@/lib/tasks/persistence';
import { stopAgentByThreadId } from '@/lib/agents/registry';

export async function POST(req: NextRequest) {
  try {
    const { taskId, subtaskId } = await req.json();

    if (!taskId || !subtaskId) {
      return NextResponse.json(
        { error: 'taskId and subtaskId required' },
        { status: 400 }
      );
    }

    // Load task
    const task = await taskPersistence.loadTask(taskId);
    if (!task) {
      return NextResponse.json(
        { error: 'Task not found' },
        { status: 404 }
      );
    }

    // Find subtask
    const subtaskIndex = task.subtasks.findIndex(s => s.id === subtaskId);
    if (subtaskIndex === -1) {
      return NextResponse.json(
        { error: 'Subtask not found' },
        { status: 404 }
      );
    }

    const subtask = task.subtasks[subtaskIndex];

    // Only allow deleting pending or in_progress subtasks
    if (subtask.status === 'completed') {
      return NextResponse.json(
        { error: 'Cannot delete a completed subtask' },
        { status: 400 }
      );
    }

    // If this subtask is currently being executed by an agent, stop it
    if (subtask.status === 'in_progress' && task.assignedAgent) {
      try {
        await stopAgentByThreadId(task.assignedAgent);
      } catch (error) {
        // Agent might already be stopped, continue anyway
        console.log('Failed to stop agent, but continuing:', error);
      }
    }

    // Remove subtask from array
    task.subtasks.splice(subtaskIndex, 1);

    // Check if all remaining DEV subtasks are completed (for auto-transition to AI review)
    const allDevCompleted = task.subtasks
      .filter(s => s.type === 'dev')
      .every(s => s.status === 'completed');
    const hasDevSubtasks = task.subtasks.some(s => s.type === 'dev');

    if (task.phase === 'in_progress' && (!hasDevSubtasks || allDevCompleted)) {
      // All dev subtasks done or no dev subtasks left - move to AI review phase
      task.phase = 'ai_review';
      task.status = 'in_progress'; // Keep in_progress since QA phase is still WIP
      task.assignedAgent = undefined;
    }

    await taskPersistence.saveTask(task);

    return NextResponse.json({
      success: true,
      message: 'Subtask deleted successfully',
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
