/**
 * Git Status API Route
 *
 * Check git status for a task's worktree
 */

import { NextRequest, NextResponse } from 'next/server';
import { getWorktreeManager } from '@/lib/git/worktree';
import { taskPersistence } from '@/lib/tasks/persistence';

const worktreeManager = getWorktreeManager();

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const taskId = searchParams.get('taskId');

    if (!taskId) {
      return NextResponse.json(
        { error: 'taskId is required' },
        { status: 400 }
      );
    }

    // Load task to get worktree path
    const task = await taskPersistence.loadTask(taskId);
    if (!task) {
      return NextResponse.json(
        { error: 'Task not found' },
        { status: 404 }
      );
    }

    if (!task.worktreePath) {
      return NextResponse.json({
        hasChanges: false,
        status: 'No worktree',
        clean: true,
      });
    }

    // Get worktree status
    const status = await worktreeManager.getWorktreeStatus(taskId);

    return NextResponse.json({
      hasChanges: status.hasChanges,
      status: status.hasChanges ? 'Changes pending' : 'Clean',
      clean: !status.hasChanges,
      exists: status.exists,
    });
  } catch (error) {
    console.error('Error getting git status:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
