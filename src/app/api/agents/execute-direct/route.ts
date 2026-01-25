/**
 * Execute Direct API Route
 *
 * Directly executes a task without planning phase.
 * Used for testing/demo purposes with minimal cost.
 * Skips:
 * - Planning phase (no Q&A, no plan generation)
 * - Subtask generation (no breakdown)
 * 
 * Directly:
 * - Accepts a command/prompt
 * - Executes it in the task's worktree
 * - Tracks results
 */

import { NextRequest, NextResponse } from 'next/server';
import { taskPersistence } from '@/lib/tasks/persistence';
import { startAgentForTask } from '@/lib/agents/registry';
import fs from 'fs/promises';
import path from 'path';

export async function POST(req: NextRequest) {
  try {
    const { taskId, command } = await req.json();

    if (!taskId) {
      return NextResponse.json(
        { error: 'taskId required' },
        { status: 400 }
      );
    }

    if (!command) {
      return NextResponse.json(
        { error: 'command required' },
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

    // Determine which CLI to use
    const cliTool = task.cliTool || 'mock';

    // Skip planning phase - go straight to in_progress
    task.phase = 'in_progress';
    task.status = 'in_progress';
    task.planApproved = true; // Mark as approved to skip planning
    await taskPersistence.saveTask(task);

    // Create execution logs directory
    const logsPath = `.code-auto/tasks/${taskId}/execution-logs.txt`;
    const logsDir = path.dirname(logsPath);
    await fs.mkdir(logsDir, { recursive: true });

    // Initialize log file
    await fs.writeFile(
      logsPath,
      `Direct Execution for task: ${task.title}\n` +
      `Task ID: ${taskId}\n` +
      `CLI Tool: ${cliTool.toUpperCase()}\n` +
      `Command: ${command}\n` +
      `Started at: ${new Date().toISOString()}\n` +
      `Working Directory: ${task.worktreePath || process.cwd()}\n` +
      `${'='.repeat(80)}\n\n`,
      'utf-8'
    );

    // Create an agent manager with the appropriate CLI tool
    // Note: actual provider selection and initialization is handled by the registry
    // (per-task provider + cwd + Amp readiness).

    // Create completion handler
    const onExecutionComplete = async (result: { success: boolean; output: string; error?: string }) => {
      await fs.appendFile(
        logsPath,
        `\n${'='.repeat(80)}\n[Execution Completed] Success: ${result.success}\n${'='.repeat(80)}\n`,
        'utf-8'
      );

      if (!result.success) {
        await fs.appendFile(logsPath, `[Error] ${result.error}\n`, 'utf-8');
        const currentTask = await taskPersistence.loadTask(taskId);
        if (currentTask) {
          currentTask.status = 'blocked';
          currentTask.assignedAgent = undefined;
          await taskPersistence.saveTask(currentTask);
        }
        return;
      }

      await fs.appendFile(logsPath, `[Output]\n${result.output}\n`, 'utf-8');

      // Mark task as completed
      const currentTask = await taskPersistence.loadTask(taskId);
      if (currentTask) {
        currentTask.phase = 'human_review';
        currentTask.status = 'completed';
        currentTask.assignedAgent = undefined;
        await taskPersistence.saveTask(currentTask);
        await fs.appendFile(logsPath, `\n[SUCCESS] Task moved to human review phase\n`, 'utf-8');
      }
    };

    // Start agent with direct command
    console.log(`[Direct Execution] Starting ${cliTool.toUpperCase()} agent for task ${taskId}`);
    console.log(`[Direct Execution] Command: ${command}`);
    console.log(`[Direct Execution] Working Dir: ${task.worktreePath || process.cwd()}`);

    const { threadId } = await startAgentForTask({
      task,
      prompt: command,
      workingDir: task.worktreePath || process.cwd(),
      onComplete: onExecutionComplete,
    });

    // Update task with thread ID
    task.assignedAgent = threadId;
    await taskPersistence.saveTask(task);

    await fs.appendFile(logsPath, `[Agent Started] Thread ID: ${threadId}\n`, 'utf-8');

    return NextResponse.json({
      success: true,
      threadId,
      message: 'Task execution started (direct mode, skipping planning)',
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
