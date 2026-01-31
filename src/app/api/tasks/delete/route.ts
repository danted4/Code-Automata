/**
 * Delete Task API Route
 *
 * Handles complete deletion of a task including:
 * - Stopping any running agents
 * - Deleting associated worktrees
 * - Removing task data
 *
 * Each step is wrapped in try-catch for graceful error handling.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTaskPersistence } from '@/lib/tasks/persistence';
import { getProjectDir } from '@/lib/project-dir';
import { stopAgentByThreadId } from '@/lib/agents/registry';
import { getWorktreeManager } from '@/lib/git/worktree';

export async function DELETE(req: NextRequest) {
  try {
    const projectDir = await getProjectDir(req);
    const taskPersistence = getTaskPersistence(projectDir);

    // Extract taskId from query parameter
    const { searchParams } = new URL(req.url);
    const taskId = searchParams.get('taskId');

    if (!taskId) {
      return NextResponse.json({ error: 'Task ID required' }, { status: 400 });
    }

    // Load task to verify it exists and get its state
    const task = await taskPersistence.loadTask(taskId);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const errors: string[] = [];

    // Step 1: Stop any running agent
    if (task.assignedAgent) {
      try {
        console.log(`[Task ${taskId}] Stopping agent with thread ID: ${task.assignedAgent}`);
        const result = await stopAgentByThreadId(task.assignedAgent);
        if (result) {
          console.log(`[Task ${taskId}] Agent stopped successfully`);
        } else {
          console.log(`[Task ${taskId}] Agent not found or already stopped`);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`[Task ${taskId}] Failed to stop agent:`, errorMsg);
        errors.push(`Failed to stop agent: ${errorMsg}`);
      }
    }

    // Step 2: Delete worktree if it exists
    if (task.worktreePath || task.branchName) {
      try {
        console.log(`[Task ${taskId}] Deleting worktree at: ${task.worktreePath}`);
        const worktreeManager = getWorktreeManager(projectDir);
        await worktreeManager.deleteWorktree(taskId, true); // force=true to handle uncommitted changes
        console.log(`[Task ${taskId}] Worktree deleted successfully`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`[Task ${taskId}] Failed to delete worktree:`, errorMsg);
        errors.push(`Failed to delete worktree: ${errorMsg}`);
      }
    }

    // Step 3: Delete task data
    try {
      console.log(`[Task ${taskId}] Deleting task data`);
      await taskPersistence.deleteTask(taskId);
      console.log(`[Task ${taskId}] Task data deleted successfully`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[Task ${taskId}] Failed to delete task data:`, errorMsg);
      errors.push(`Failed to delete task data: ${errorMsg}`);

      // If we can't delete the task data, return failure
      return NextResponse.json(
        {
          success: false,
          error: 'Failed to delete task data',
          details: errorMsg,
          partialErrors: errors,
        },
        { status: 500 }
      );
    }

    // Return success response
    if (errors.length > 0) {
      return NextResponse.json({
        success: true,
        message: 'Task deleted with warnings',
        warnings: errors,
      });
    }

    return NextResponse.json({
      success: true,
      message: 'Task deleted successfully',
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[Delete Task API] Unexpected error:', errorMsg);
    return NextResponse.json(
      {
        success: false,
        error: 'Unexpected error during task deletion',
        details: errorMsg,
      },
      { status: 500 }
    );
  }
}
