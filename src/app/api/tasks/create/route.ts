/**
 * Create Task API Route
 */

import { NextRequest, NextResponse } from 'next/server';
import { taskPersistence } from '@/lib/tasks/persistence';
import { Task } from '@/lib/tasks/schema';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // Generate task ID
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const task: Task = {
      id: taskId,
      title: body.title || 'Untitled Task',
      description: body.description || '',
      phase: body.phase || 'discovery',
      status: body.status || 'pending',
      subtasks: body.subtasks || [],
      worktreePath: body.worktreePath,
      branchName: body.branchName || `auto-claude/${taskId}`,
      githubIssue: body.githubIssue,
      gitlabIssue: body.gitlabIssue,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: body.metadata || {},
    };

    await taskPersistence.saveTask(task);

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
