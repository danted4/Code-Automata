/**
 * List Tasks API Route
 */

import { NextResponse } from 'next/server';
import { taskPersistence } from '@/lib/tasks/persistence';

export async function GET() {
  try {
    const tasks = await taskPersistence.listTasks();
    return NextResponse.json(tasks);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
