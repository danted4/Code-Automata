/**
 * Skip Subtask API Route
 *
 * Marks a subtask as completed (skips it)
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
        await stopAgentByThreadId(task.assignedAgent);
      } catch (error) {
        // Agent might already be stopped, continue anyway
        console.log('Failed to stop agent, but continuing:', error);
      }
    }

    // Mark as completed (skipped)
    task.subtasks[subtaskIndex].status = 'completed';

    // Check if all DEV subtasks are now completed (for auto-transition to AI review)
    const allDevCompleted = task.subtasks
      .filter(s => s.type === 'dev')
      .every(s => s.status === 'completed');

    const shouldAutoStartReview = allDevCompleted && task.phase === 'in_progress';
    if (allDevCompleted && task.phase === 'in_progress') {
      // All dev subtasks done - move to AI review phase
      task.phase = 'ai_review';
      task.status = 'in_progress'; // Keep in_progress since QA phase is still WIP
      task.assignedAgent = undefined;
    }

    await taskPersistence.saveTask(task);

    // If we advanced to ai_review by skipping the last dev subtask, auto-start QA.
    // This matches the auto-transition behavior in start-development.
    if (shouldAutoStartReview) {
      try {
        await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/agents/start-review`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId }),
        });
      } catch (error) {
        // Non-fatal: user can still start review manually.
        console.log('Auto-start review failed:', error);
      }
    }

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
