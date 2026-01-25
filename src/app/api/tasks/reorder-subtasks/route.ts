/**
 * Reorder Subtasks API Route
 *
 * Reorders subtasks for a given task
 */

import { NextRequest, NextResponse } from 'next/server';
import { taskPersistence } from '@/lib/tasks/persistence';

export async function POST(req: NextRequest) {
  try {
    const { taskId, subtaskIds } = await req.json();

    if (!taskId || !subtaskIds || !Array.isArray(subtaskIds)) {
      return NextResponse.json(
        { error: 'taskId and subtaskIds (array) required' },
        { status: 400 }
      );
    }

    // Load task
    const task = await taskPersistence.loadTask(taskId);
    if (!task) {
      return NextResponse.json(
        { error: 'Task not found' },
        { status: 404 }
      );
    }

    // Validate that all subtaskIds exist in the task
    const existingIds = new Set(task.subtasks.map(s => s.id));
    const allIdsValid = subtaskIds.every(id => existingIds.has(id));

    if (!allIdsValid || subtaskIds.length !== task.subtasks.length) {
      return NextResponse.json(
        { error: 'Invalid subtask IDs' },
        { status: 400 }
      );
    }

    // Reorder subtasks based on the new order
    const reorderedSubtasks = subtaskIds.map(id =>
      task.subtasks.find(s => s.id === id)!
    );

    // Update task with new subtask order
    task.subtasks = reorderedSubtasks;
    task.updatedAt = Date.now();

    await taskPersistence.saveTask(task);

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
