/**
 * Approve Plan API Route
 *
 * Approves a plan and optionally starts development
 */

import { NextRequest, NextResponse } from 'next/server';
import { taskPersistence } from '@/lib/tasks/persistence';
import { agentManager } from '@/lib/agents/singleton';
import fs from 'fs/promises';

export async function POST(req: NextRequest) {
  try {
    const { taskId, startDevelopment } = await req.json();

    if (!taskId) {
      return NextResponse.json(
        { error: 'taskId required' },
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

    // Update task status
    task.planApproved = true;
    task.planningStatus = 'plan_approved';
    task.locked = false;
    task.status = 'pending';

    // Log to planning logs
    const logsPath = task.planningLogsPath || `.code-auto/tasks/${taskId}/planning-logs.txt`;
    await fs.appendFile(
      logsPath,
      `\n${'='.repeat(80)}\n` +
      `[Plan Approved] ${new Date().toISOString()}\n` +
      `Start Development: ${startDevelopment ? 'Yes' : 'No'}\n` +
      `${'='.repeat(80)}\n\n`,
      'utf-8'
    );

    if (startDevelopment) {
      // Start development immediately
      await fs.appendFile(logsPath, `[Starting Development]\n`, 'utf-8');

      const prompt = `Implement the following task according to the approved plan:

**Task:** ${task.title}
**Description:** ${task.description}

**Approved Plan:**
${task.planContent}

Please follow the plan carefully and implement all the steps outlined.`;

      try {
        const threadId = await agentManager.startAgent(taskId, prompt, {
          workingDir: task.worktreePath || process.cwd(),
        });

        task.assignedAgent = threadId;
        task.status = 'in_progress';
        task.phase = 'in_progress';

        await fs.appendFile(logsPath, `[Agent Started] Thread ID: ${threadId}\n`, 'utf-8');
      } catch (error) {
        await fs.appendFile(
          logsPath,
          `[Error Starting Agent] ${error instanceof Error ? error.message : 'Unknown error'}\n`,
          'utf-8'
        );
        throw error;
      }
    }

    await taskPersistence.saveTask(task);

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
