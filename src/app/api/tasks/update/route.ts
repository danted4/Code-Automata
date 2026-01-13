/**
 * Update Task API Route
 */

import { NextRequest, NextResponse } from 'next/server';
import { taskPersistence } from '@/lib/tasks/persistence';

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
