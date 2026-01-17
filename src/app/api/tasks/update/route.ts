/**
 * Update Task API Route
 *
 * Updates task state and handles phase transitions.
 * When a task moves to "done" phase, its worktree is NOT automatically deleted
 * (user may need it for PR/MR review). Manual cleanup is available via the
 * worktree API endpoint.
 */

import { NextRequest, NextResponse } from 'next/server';
import { taskPersistence } from '@/lib/tasks/persistence';
import { getWorktreeManager } from '@/lib/git/worktree';

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { taskId, ...updates } = body;

    if (!taskId) {
      return NextResponse.json(
        { error: 'Task ID required' },
        { status: 400 }
      );
    }

    const task = await taskPersistence.loadTask(taskId);
    if (!task) {
      return NextResponse.json(
        { error: 'Task not found' },
        { status: 404 }
      );
    }

    // Update task
    const updatedTask = {
      ...task,
      ...updates,
      updatedAt: Date.now(),
    };

    await taskPersistence.saveTask(updatedTask);

    // Handle phase transitions
    // Note: We don't auto-delete worktrees on completion because user may need
    // them for PR/MR review. Worktree cleanup is manual via /api/git/worktree endpoint.
    if (updates.phase === 'done' && task.phase !== 'done' && task.worktreePath) {
      console.log(`[Task ${taskId}] Transitioned to done. Worktree preserved at ${task.worktreePath}`);
    }

    return NextResponse.json(updatedTask);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
