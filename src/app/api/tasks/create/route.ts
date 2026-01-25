/**
 * Create Task API Route
 *
 * Creates a new task and automatically sets up a git worktree for it.
 * Worktree creation is critical for task execution.
 */

import { NextRequest, NextResponse } from 'next/server';
import { taskPersistence } from '@/lib/tasks/persistence';
import { Task } from '@/lib/tasks/schema';
import { getWorktreeManager } from '@/lib/git/worktree';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // Generate task ID
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const task: Task = {
      id: taskId,
      title: body.title || taskId, // Use task ID as title if not provided
      description: body.description || '',
      phase: body.phase || 'planning',
      status: body.status || 'pending',
      subtasks: body.subtasks || [],

      // CLI Configuration
      cliTool: body.cliTool,
      cliConfig: body.cliConfig,

      // Workflow Control
      requiresHumanReview: body.requiresHumanReview || false,
      planApproved: body.planApproved || false,
      locked: body.locked || false,

      // Planning Phase
      planningStatus: body.planningStatus || 'not_started',
      planningData: body.planningData,
      planContent: body.planContent,
      planningLogsPath: body.planningLogsPath ? body.planningLogsPath.replace('{task-id}', taskId) : `.code-auto/tasks/${taskId}/planning-logs.txt`,

      // Execution
      worktreePath: body.worktreePath,
      branchName: body.branchName || `code-auto/${taskId}`,

      // Integrations
      githubIssue: body.githubIssue,
      gitlabIssue: body.gitlabIssue,

      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: body.metadata || {},
    };

    // Save task first
    await taskPersistence.saveTask(task);

    // Then create worktree for the task
    // If worktree creation fails, we don't fail the task creation
    // (user can still work with task, but won't have isolated branch)
    try {
      const manager = getWorktreeManager();
      const gitAvailable = await manager.verifyGitAvailable();

      if (gitAvailable) {
        const worktreeInfo = await manager.createWorktree(taskId);
        // Update task with worktree info
        task.worktreePath = worktreeInfo.path;
        task.branchName = worktreeInfo.branchName;
        await taskPersistence.saveTask(task);

        console.log(`[Task ${taskId}] Worktree created: ${worktreeInfo.path}`);
      } else {
        console.warn(`[Task ${taskId}] Git not available, skipping worktree creation`);
      }
    } catch (worktreeError) {
      // Log but don't fail task creation
      const message = worktreeError instanceof Error ? worktreeError.message : 'Unknown error';
      console.warn(`[Task ${taskId}] Worktree creation failed: ${message}`);
      // Return success anyway - task is created, just without worktree
    }

    return NextResponse.json(task);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
