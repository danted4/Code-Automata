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
import { stopAgentByThreadId } from '@/lib/agents/registry';

export async function POST(req: NextRequest) {
  try {
    const projectDir = await getProjectDir(req);
    const manager = getWorktreeManager(projectDir);

    const body = await req.json();
    const {
      action,
      taskId,
      force,
      alsoDeleteBranch,
      alsoDeleteFromRemote,
      includeOrphans,
      includeClean,
      includeDirty,
    } = body;
    const worktreePath = typeof body.path === 'string' ? body.path : undefined;

    if (
      action !== 'cleanup-all' &&
      action !== 'cleanup-orphans' &&
      action !== 'cleanup' &&
      !taskId
    ) {
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
      const taskPersistence = getTaskPersistence(projectDir);
      const task = await taskPersistence.loadTask(taskId);
      if (task?.assignedAgent) {
        try {
          await stopAgentByThreadId(task.assignedAgent);
        } catch (e) {
          console.warn(`[Worktree API] Failed to stop agent for ${taskId}:`, e);
        }
      }
      await manager.deleteWorktree(
        taskId,
        force || false,
        alsoDeleteBranch,
        alsoDeleteFromRemote,
        worktreePath
      );
      await taskPersistence.deleteTask(taskId);
      return NextResponse.json({
        success: true,
        message: `Worktree and task deleted for ${taskId}`,
      });
    }

    if (action === 'cleanup-all') {
      const worktrees = await manager.listWorktrees();
      const taskPersistence = getTaskPersistence(projectDir);
      for (const wt of worktrees) {
        const task = await taskPersistence.loadTask(wt.taskId);
        if (task?.assignedAgent) {
          try {
            await stopAgentByThreadId(task.assignedAgent);
          } catch (e) {
            console.warn(`[Worktree API] Failed to stop agent for ${wt.taskId}:`, e);
          }
        }
        await manager.deleteWorktree(
          wt.taskId,
          force ?? true,
          alsoDeleteBranch ?? false,
          alsoDeleteFromRemote ?? false,
          wt.path
        );
        await taskPersistence.deleteTask(wt.taskId);
      }
      return NextResponse.json({
        success: true,
        message: `All ${worktrees.length} worktree(s) and tasks cleaned up`,
      });
    }

    if (action === 'cleanup-orphans') {
      const worktrees = await manager.listWorktrees();
      const taskPersistence = getTaskPersistence(projectDir);
      const tasks = await taskPersistence.listTasks();
      const taskIds = new Set(tasks.map((t) => t.id));
      const orphans = worktrees.filter((wt) => !taskIds.has(wt.taskId));
      for (const wt of orphans) {
        await manager.deleteWorktree(
          wt.taskId,
          force ?? true,
          alsoDeleteBranch ?? true,
          alsoDeleteFromRemote ?? false,
          wt.path
        );
      }
      return NextResponse.json({
        success: true,
        message: `Cleaned up ${orphans.length} orphan worktree(s)`,
        removedCount: orphans.length,
      });
    }

    if (action === 'cleanup') {
      const worktrees = await manager.listWorktrees();
      const taskPersistence = getTaskPersistence(projectDir);
      const tasks = await taskPersistence.listTasks();
      const taskIds = new Set(tasks.map((t) => t.id));

      const toRemove = worktrees.filter((wt) => {
        const isOrphan = !taskIds.has(wt.taskId);
        if (includeOrphans && isOrphan) return true;
        if (isOrphan) return false;
        if (includeClean && !wt.isDirty) return true;
        if (includeDirty && wt.isDirty) return true;
        return false;
      });

      for (const wt of toRemove) {
        const task = await taskPersistence.loadTask(wt.taskId);
        if (task?.assignedAgent) {
          try {
            await stopAgentByThreadId(task.assignedAgent);
          } catch (e) {
            console.warn(`[Worktree API] Failed to stop agent for ${wt.taskId}:`, e);
          }
        }
        await manager.deleteWorktree(
          wt.taskId,
          force ?? true,
          alsoDeleteBranch ?? false,
          alsoDeleteFromRemote ?? false,
          wt.path
        );
        if (taskIds.has(wt.taskId)) {
          await taskPersistence.deleteTask(wt.taskId);
        }
      }

      return NextResponse.json({
        success: true,
        message: `Cleaned up ${toRemove.length} worktree(s)`,
        removedCount: toRemove.length,
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
