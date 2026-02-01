/**
 * Git Worktree API Route
 *
 * Handles worktree creation, deletion, and status queries
 * Used during task lifecycle:
 * - POST /api/git/worktree (create) - Called after task creation
 * - DELETE /api/git/worktree (delete) - Called when task completes
 * - GET /api/git/worktree (status) - Called to check worktree state
 */

import { NextRequest, NextResponse } from 'next/server';
import { getWorktreeManager } from '@/lib/git/worktree';
import { getProjectDir } from '@/lib/project-dir';
import { getTaskPersistence } from '@/lib/tasks/persistence';

export async function POST(req: NextRequest) {
  try {
    const projectDir = await getProjectDir(req);
    const manager = getWorktreeManager(projectDir);

    const { action, taskId, force, alsoDeleteBranch } = await req.json();

    if (action !== 'cleanup-all' && !taskId) {
      return NextResponse.json({ error: 'taskId is required' }, { status: 400 });
    }

    // Verify git is available
    const gitAvailable = await manager.verifyGitAvailable();
    if (!gitAvailable) {
      return NextResponse.json(
        { error: 'Git is not available or not in a git repository' },
        { status: 503 }
      );
    }

    if (action === 'create') {
      const worktreeInfo = await manager.createWorktree(taskId);
      return NextResponse.json({
        success: true,
        worktreeInfo,
        message: `Worktree created at ${worktreeInfo.path}`,
      });
    }

    if (action === 'delete') {
      await manager.deleteWorktree(taskId, force || false, alsoDeleteBranch);
      return NextResponse.json({
        success: true,
        message: `Worktree deleted for task ${taskId}`,
      });
    }

    if (action === 'cleanup-all') {
      await manager.cleanupAllWorktrees(force || false);
      return NextResponse.json({
        success: true,
        message: 'All worktrees cleaned up',
      });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Worktree API Error]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const projectDir = await getProjectDir(req);
    const manager = getWorktreeManager(projectDir);

    const { searchParams } = new URL(req.url);
    const taskId = searchParams.get('taskId');
    const action = searchParams.get('action') || 'status';

    // Verify git is available
    const gitAvailable = await manager.verifyGitAvailable();
    if (!gitAvailable) {
      return NextResponse.json(
        { error: 'Git is not available or not in a git repository' },
        { status: 503 }
      );
    }

    if (action === 'status') {
      if (!taskId) {
        return NextResponse.json({ error: 'taskId is required for status check' }, { status: 400 });
      }

      const status = await manager.getWorktreeStatus(taskId);
      return NextResponse.json({ status });
    }

    if (action === 'list') {
      const enriched = await manager.listWorktreesEnriched();
      const taskPersistence = getTaskPersistence(projectDir);
      const tasks = await taskPersistence.listTasks();
      const taskIds = new Set(tasks.map((t) => t.id));

      const worktrees = enriched.map((wt) => ({
        taskId: wt.taskId,
        path: wt.path,
        branchName: wt.branchName,
        isDirty: wt.isDirty,
        linkedTaskId: wt.taskId,
        isOrphan: !taskIds.has(wt.taskId),
        diskUsageBytes: wt.diskUsageBytes,
      }));

      const totalDiskUsageBytes = worktrees.reduce((sum, wt) => sum + wt.diskUsageBytes, 0);

      return NextResponse.json({
        worktrees,
        count: worktrees.length,
        totalDiskUsageBytes,
      });
    }

    if (action === 'info') {
      if (!taskId) {
        return NextResponse.json({ error: 'taskId is required for info' }, { status: 400 });
      }

      const mainRepo = await manager.getMainRepoPath();
      const mainBranch = await manager.getMainBranch();
      const worktreePath = await manager.getWorktreePath(taskId);

      return NextResponse.json({
        taskId,
        mainRepo,
        mainBranch,
        worktreePath,
        branchName: `code-auto/${taskId}`,
      });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Worktree API Error]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
