/**
 * Local dev seed: create a single Amp task
 *
 * Why:
 * - Keeps Kanban UI behavior unchanged
 * - Mirrors New Task modal defaults, but via API for quick testing
 * - Ensures a worktree exists (critical for safe execution)
 *
 * Request body (all optional):
 * {
 *   "title": "My task",
 *   "description": "Do X",
 *   "mode": "rush" | "smart",
 *   "startPlanning": true,
 *   "resetFirst": true,
 *   "forceReset": true
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { taskPersistence } from '@/lib/tasks/persistence';
import type { Task } from '@/lib/tasks/schema';
import { getWorktreeManager } from '@/lib/git/worktree';

function getBaseUrl(req: NextRequest): string {
  const origin = req.headers.get('origin');
  if (origin) return origin;
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({} as any));

    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : undefined;
    const description = typeof body.description === 'string' ? body.description : 'Seeded Amp task (planning → auto dev)';
    const mode = body.mode === 'smart' ? 'smart' : 'rush';
    const startPlanning = body.startPlanning !== false; // default true
    const resetFirst = !!body.resetFirst;
    const forceReset = !!body.forceReset;

    const baseUrl = getBaseUrl(req);

    if (resetFirst) {
      const res = await fetch(`${baseUrl}/api/dev/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: forceReset }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || 'Failed to reset local state');
      }
    }

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const task: Task = {
      id: taskId,
      title: title || taskId,
      description,
      phase: 'planning',
      status: 'pending',
      subtasks: [],

      cliTool: 'amp',
      cliConfig: { mode },

      requiresHumanReview: false,
      planApproved: false,
      locked: false,

      planningStatus: 'not_started',
      planningData: undefined,
      planContent: undefined,
      planningLogsPath: `.code-auto/tasks/${taskId}/planning-logs.txt`,

      assignedAgent: undefined,
      worktreePath: undefined,
      branchName: `code-auto/${taskId}`,

      githubIssue: undefined,
      gitlabIssue: undefined,

      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: { estimatedComplexity: 'medium', isTestData: true },
    };

    // Save first (mirrors create route)
    await taskPersistence.saveTask(task);

    // Create worktree
    const manager = getWorktreeManager();
    const gitAvailable = await manager.verifyGitAvailable();
    if (gitAvailable) {
      const wt = await manager.createWorktree(taskId);
      task.worktreePath = wt.path;
      task.branchName = wt.branchName;
      await taskPersistence.saveTask(task);
    }

    if (startPlanning) {
      // Mirror New Task modal behavior: start planning immediately
      const res = await fetch(`${baseUrl}/api/agents/start-planning`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || 'Failed to start planning');
      }
    }

    return NextResponse.json({
      success: true,
      taskId,
      startedPlanning: startPlanning,
      worktreePath: task.worktreePath,
      message: 'Seeded Amp task created',
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

