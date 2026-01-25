/**
 * Stop Agent API Route
 *
 * Stops a running AI agent
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAgentSessionByThreadId, stopAgentByThreadId } from '@/lib/agents/registry';
import { taskPersistence } from '@/lib/tasks/persistence';

export async function POST(req: NextRequest) {
  try {
    const { threadId } = await req.json();

    if (!threadId) {
      return NextResponse.json(
        { error: 'threadId required' },
        { status: 400 }
      );
    }

    // Get agent session
    const session = getAgentSessionByThreadId(threadId);
    if (!session) {
      return NextResponse.json(
        { error: 'Agent not found' },
        { status: 404 }
      );
    }

    // Stop agent
    const stopped = await stopAgentByThreadId(threadId);
    if (!stopped) {
      return NextResponse.json(
        { error: 'Agent not found' },
        { status: 404 }
      );
    }

    // Update task - move back to planning phase when agent stopped
    const task = await taskPersistence.loadTask(stopped.taskId);
    if (task && task.assignedAgent === threadId) {
      task.assignedAgent = undefined;
      task.status = 'pending';
      task.phase = 'planning';
      await taskPersistence.saveTask(task);
    }

    return NextResponse.json({
      success: true,
      message: 'Agent stopped successfully',
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
