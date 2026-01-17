/**
 * Skip Subtask API Route
 *
 * Marks a subtask as completed (skips it)
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

    // Only allow skipping pending or in_progress subtasks
    if (subtask.status === 'completed') {
      return NextResponse.json(
        { error: 'Cannot skip a completed subtask' },
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

    // Mark as completed (skipped)
    task.subtasks[subtaskIndex].status = 'completed';

    // Check if all subtasks are now completed
    const allCompleted = task.subtasks.every(s => s.status === 'completed');

    if (allCompleted) {
      // All subtasks done - move to AI review
      task.status = 'completed';
      task.phase = 'ai_review';
      task.assignedAgent = undefined;
    }

    await taskPersistence.saveTask(task);

    return NextResponse.json({
      success: true,
      message: 'Subtask skipped successfully',
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
