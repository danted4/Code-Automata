/**
 * Stop Agent API Route
 *
 * Stops a running AI agent
 */

import { NextRequest, NextResponse } from 'next/server';
import { agentManager } from '@/lib/agents/singleton';
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
    const session = agentManager.getAgentStatus(threadId);
    if (!session) {
      return NextResponse.json(
        { error: 'Agent not found' },
        { status: 404 }
      );
    }

    // Stop agent
    await agentManager.stopAgent(threadId);

    // Update task
    const task = await taskPersistence.loadTask(session.taskId);
    if (task && task.assignedAgent === threadId) {
      task.assignedAgent = undefined;
      task.status = 'pending';
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
