/**
 * Approve Plan API Route
 *
 * Approves a plan and optionally starts development
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTaskPersistence } from '@/lib/tasks/persistence';
import { getProjectDir } from '@/lib/project-dir';
import { cleanPlanningArtifactsFromWorktree } from '@/lib/worktree/cleanup';
import fs from 'fs/promises';
import path from 'path';

export async function POST(req: NextRequest) {
  try {
    const projectDir = await getProjectDir(req);
    const taskPersistence = getTaskPersistence(projectDir);

    const { taskId, startDevelopment } = await req.json();

    if (!taskId) {
      return NextResponse.json({ error: 'taskId required' }, { status: 400 });
    }

    // Load task
    const task = await taskPersistence.loadTask(taskId);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Update task status
    task.planApproved = true;
    task.planningStatus = 'plan_approved';
    task.locked = false;
    task.status = 'pending';

    // Log to planning logs
    const logsPath = task.planningLogsPath
      ? path.isAbsolute(task.planningLogsPath)
        ? task.planningLogsPath
        : path.join(projectDir, task.planningLogsPath)
      : path.join(projectDir, '.code-auto', 'tasks', taskId, 'planning-logs.txt');
    await fs.appendFile(
      logsPath,
      `\n${'='.repeat(80)}\n` +
        `[Plan Approved] ${new Date().toISOString()}\n` +
        `Start Development: ${startDevelopment ? 'Yes' : 'No'}\n` +
        `${'='.repeat(80)}\n\n`,
      'utf-8'
    );

    // IMPORTANT: Save task BEFORE starting development so planApproved flag is persisted
    await taskPersistence.saveTask(task);

    // Clean planning artifacts from worktree (implementation-plan.json, etc.) before dev
    if (task.worktreePath) {
      await cleanPlanningArtifactsFromWorktree(task.worktreePath).catch(() => {});
    }

    if (startDevelopment) {
      // Start development immediately (this will generate subtasks and execute them)
      await fs.appendFile(logsPath, `[Starting Development - Generating Subtasks]\n`, 'utf-8');

      try {
        const projectPath = req.headers.get('X-Project-Path');
        const fetchHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
        if (projectPath) fetchHeaders['X-Project-Path'] = projectPath;
        const response = await fetch(
          `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/agents/start-development`,
          {
            method: 'POST',
            headers: fetchHeaders,
            body: JSON.stringify({ taskId }),
          }
        );

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || 'Failed to start development');
        }

        const result = await response.json();
        await fs.appendFile(
          logsPath,
          `[Development Started] Thread ID: ${result.threadId}\n`,
          'utf-8'
        );

        // Don't update task here - the start-development endpoint will handle it
      } catch (error) {
        await fs.appendFile(
          logsPath,
          `[Error Starting Development] ${error instanceof Error ? error.message : 'Unknown error'}\n`,
          'utf-8'
        );
        throw error;
      }
    }

    // Task already saved above before starting development
    return NextResponse.json({
      success: true,
      message: startDevelopment ? 'Plan approved and development started' : 'Plan approved',
      task,
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
