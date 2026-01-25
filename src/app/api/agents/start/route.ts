/**
 * Start Agent API Route
 *
 * Starts an AI agent on a task
 */

import { NextRequest, NextResponse } from 'next/server';
import { taskPersistence } from '@/lib/tasks/persistence';
import { getAgentManagerForTask, startAgentForTask } from '@/lib/agents/registry';

export async function POST(req: NextRequest) {
  try {
    const { taskId, prompt } = await req.json();

    if (!taskId || !prompt) {
      return NextResponse.json(
        { error: 'taskId and prompt required' },
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

    // Check if task already has an agent assigned
    if (task.assignedAgent) {
      const mgr = await getAgentManagerForTask(task);
      const existingSession = mgr.getAgentStatus(task.assignedAgent);
      if (existingSession && existingSession.status === 'running') {
        return NextResponse.json(
          { error: 'Task already has an agent running' },
          { status: 409 }
        );
      }
    }

    // Start agent
    const { threadId } = await startAgentForTask({
      task,
      prompt,
      workingDir: task.worktreePath || process.cwd(),
      // TODO: Add context from memory system
    });

    // Update task with assigned agent and move to in_progress phase
    task.assignedAgent = threadId;
    task.status = 'in_progress';
    task.phase = 'in_progress';
    await taskPersistence.saveTask(task);

    return NextResponse.json({
      success: true,
      threadId,
      message: 'Agent started successfully',
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
