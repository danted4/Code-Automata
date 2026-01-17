/**
 * Delete Subtask API Route
 *
 * Removes a subtask from the task
 */

import { NextRequest, NextResponse } from 'next/server';
import { taskPersistence } from '@/lib/tasks/persistence';
import { agentManager } from '@/lib/agents/singleton';

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
        await agentManager.stopAgent(task.assignedAgent);
      } catch (error) {
        // Agent might already be stopped, continue anyway
        console.log('Failed to stop agent, but continuing:', error);
      }
    }

    // Remove subtask from array
    task.subtasks.splice(subtaskIndex, 1);

    // Check if all remaining subtasks are completed
    const allCompleted = task.subtasks.length > 0 && task.subtasks.every(s => s.status === 'completed');

    if (allCompleted) {
      // All subtasks done - move to AI review
      task.status = 'completed';
      task.phase = 'ai_review';
      task.assignedAgent = undefined;
    } else if (task.subtasks.length === 0) {
      // No subtasks left - mark as completed
      task.status = 'completed';
      task.phase = 'ai_review';
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
