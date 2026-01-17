/**
 * Start Development API Route
 *
 * Starts development phase:
 * 1. Generate subtasks from approved plan
 * 2. Validate subtasks JSON
 * 3. Execute subtasks sequentially
 */

import { NextRequest, NextResponse } from 'next/server';
import { agentManager } from '@/lib/agents/singleton';
import { taskPersistence } from '@/lib/tasks/persistence';
import fs from 'fs/promises';
import path from 'path';

interface Subtask {
  id: string;
  content: string;
  label: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export async function POST(req: NextRequest) {
  try {
    const { taskId } = await req.json();

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

    // Check if task has approved plan
    if (!task.planApproved || !task.planContent) {
      return NextResponse.json(
        { error: 'Task must have an approved plan before starting development' },
        { status: 400 }
      );
    }

    // Ensure development logs directory exists
    const logsPath = `.code-auto/tasks/${taskId}/development-logs.txt`;
    const logsDir = path.dirname(logsPath);
    await fs.mkdir(logsDir, { recursive: true });

    // Initialize log file
    await fs.writeFile(
      logsPath,
      `Development started for task: ${task.title}\n` +
      `Task ID: ${taskId}\n` +
      `Started at: ${new Date().toISOString()}\n` +
      `${'='.repeat(80)}\n\n`,
      'utf-8'
    );

    // Build subtask generation prompt
    const prompt = buildSubtaskGenerationPrompt(task);

    // Create completion handler for subtask generation
    const onSubtasksGenerated = async (result: { success: boolean; output: string; error?: string }) => {
      await fs.appendFile(logsPath, `\n[Subtask Generation Completed] Success: ${result.success}\n`, 'utf-8');

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

      // Parse subtasks JSON
      try {
        const jsonMatch = result.output.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error('No JSON found in output');
        }

        const parsedOutput = JSON.parse(jsonMatch[0]);
        await fs.appendFile(logsPath, `[Parsed JSON successfully]\n`, 'utf-8');

        // Validate subtasks structure
        if (!parsedOutput.subtasks || !Array.isArray(parsedOutput.subtasks)) {
          throw new Error('Invalid subtasks structure: missing subtasks array');
        }

        const subtasks: Subtask[] = parsedOutput.subtasks;

        // Validate each subtask
        for (const subtask of subtasks) {
          if (!subtask.id || !subtask.content || !subtask.label) {
            throw new Error(`Invalid subtask: missing required fields (id, content, label)`);
          }
        }

        await fs.appendFile(logsPath, `[Validated ${subtasks.length} subtasks]\n`, 'utf-8');

        // Save subtasks to task
        const currentTask = await taskPersistence.loadTask(taskId);
        if (!currentTask) return;

        currentTask.subtasks = subtasks.map(s => ({
          ...s,
          status: 'pending' as const,
          activeForm: s.activeForm || `Working on ${s.label}`,
        }));
        currentTask.status = 'in_progress';
        currentTask.assignedAgent = undefined; // Clear agent after subtask generation
        await taskPersistence.saveTask(currentTask);

        await fs.appendFile(logsPath, `[Subtasks saved to task]\n`, 'utf-8');

        // Start sequential execution
        await fs.appendFile(logsPath, `\n${'='.repeat(80)}\n[Starting Sequential Execution]\n${'='.repeat(80)}\n\n`, 'utf-8');

        // Execute subtasks one by one
        await executeSubtasksSequentially(taskId, subtasks, logsPath);

      } catch (parseError) {
        await fs.appendFile(
          logsPath,
          `[Parse Error] Failed to parse/validate subtasks: ${parseError instanceof Error ? parseError.message : 'Unknown error'}\n`,
          'utf-8'
        );

        const currentTask = await taskPersistence.loadTask(taskId);
        if (currentTask) {
          currentTask.status = 'blocked';
          currentTask.assignedAgent = undefined;
          await taskPersistence.saveTask(currentTask);
        }
      }
    };

    // Start subtask generation agent
    await fs.appendFile(logsPath, `[Starting Subtask Generation Agent]\n`, 'utf-8');

    const threadId = await agentManager.startAgent(taskId, prompt, {
      workingDir: task.worktreePath || process.cwd(),
      onComplete: onSubtasksGenerated,
    });

    // Update task status
    task.assignedAgent = threadId;
    task.status = 'in_progress';
    task.phase = 'in_progress';
    await taskPersistence.saveTask(task);

    await fs.appendFile(logsPath, `[Agent Started] Thread ID: ${threadId}\n`, 'utf-8');

    return NextResponse.json({
      success: true,
      threadId,
      message: 'Development started - generating subtasks',
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

/**
 * Build prompt for subtask generation
 */
function buildSubtaskGenerationPrompt(task: any): string {
  return `You are an AI development assistant. Your task is to break down an implementation plan into actionable subtasks.

**Task:** ${task.title}
**Description:** ${task.description}

**Approved Implementation Plan:**
${task.planContent}

# SUBTASK GENERATION

Your goal is to break down this plan into 5-15 concrete, actionable subtasks that can be executed sequentially.

For each subtask, provide:
- **id**: Unique identifier (e.g., "subtask-1", "subtask-2")
- **content**: Detailed description of what needs to be done (be specific about files, logic, etc.)
- **label**: Short label (3-5 words) for UI display (e.g., "Create API endpoint", "Add validation logic")
- **activeForm**: Present continuous form for progress display (e.g., "Creating API endpoint", "Adding validation logic")

**Guidelines:**
1. Break down complex steps into smaller, manageable subtasks
2. Each subtask should be completable independently
3. Order subtasks logically (dependencies first)
4. Be specific about files, functions, and changes needed
5. Cap at 15 subtasks maximum

Return your subtasks in the following JSON format:
{
  "subtasks": [
    {
      "id": "subtask-1",
      "content": "Create the API route file at src/app/api/example/route.ts with POST endpoint handler",
      "label": "Create API endpoint",
      "activeForm": "Creating API endpoint"
    },
    {
      "id": "subtask-2",
      "content": "Add input validation using Zod schema for request body parameters",
      "label": "Add input validation",
      "activeForm": "Adding input validation"
    }
  ]
}

IMPORTANT: Return ONLY valid JSON. Do not include any markdown formatting or additional text.`;
}

/**
 * Execute subtasks sequentially
 */
async function executeSubtasksSequentially(taskId: string, subtasks: Subtask[], logsPath: string) {
  for (let i = 0; i < subtasks.length; i++) {
    const subtask = subtasks[i];

    // Load fresh task data to check current status
    const task = await taskPersistence.loadTask(taskId);
    if (!task) return;

    // Check if this subtask was already completed (e.g., skipped by user)
    if (task.subtasks[i].status === 'completed') {
      await fs.appendFile(
        logsPath,
        `\n${'='.repeat(80)}\n[Subtask ${i + 1}/${subtasks.length}] ${subtask.label} - SKIPPED (already completed)\n${'='.repeat(80)}\n\n`,
        'utf-8'
      );
      continue; // Skip to next subtask
    }

    await fs.appendFile(
      logsPath,
      `\n${'='.repeat(80)}\n[Subtask ${i + 1}/${subtasks.length}] ${subtask.label}\n${'='.repeat(80)}\n\n`,
      'utf-8'
    );

    // Update subtask to in_progress
    task.subtasks[i].status = 'in_progress';
    await taskPersistence.saveTask(task);

    // Execute subtask
    const prompt = `Execute the following subtask as part of the implementation plan:

**Subtask:** ${subtask.label}
**Details:** ${subtask.content}

Please implement this subtask following best practices.`;

    // Create completion handler for this subtask
    const onSubtaskComplete = async (result: { success: boolean; output: string; error?: string }) => {
      await fs.appendFile(logsPath, `\n[Subtask ${i + 1} Completed] Success: ${result.success}\n`, 'utf-8');

      if (!result.success) {
        await fs.appendFile(logsPath, `[Error] ${result.error}\n`, 'utf-8');

        const currentTask = await taskPersistence.loadTask(taskId);
        if (currentTask) {
          currentTask.subtasks[i].status = 'pending'; // Reset to pending on error
          currentTask.status = 'blocked';
          await taskPersistence.saveTask(currentTask);
        }
        return;
      }

      await fs.appendFile(logsPath, `[Output]\n${result.output}\n`, 'utf-8');

      // Mark subtask as completed
      const currentTask = await taskPersistence.loadTask(taskId);
      if (currentTask) {
        currentTask.subtasks[i].status = 'completed';

        // Check if all subtasks are completed
        const allCompleted = currentTask.subtasks.every(s => s.status === 'completed');
        if (allCompleted) {
          currentTask.status = 'completed';
          currentTask.phase = 'ai_review'; // Move to AI review phase
          currentTask.assignedAgent = undefined; // Clear agent
          await fs.appendFile(logsPath, `\n${'='.repeat(80)}\n[ALL SUBTASKS COMPLETED - Moving to AI Review]\n${'='.repeat(80)}\n`, 'utf-8');
        }

        await taskPersistence.saveTask(currentTask);
      }
    };

    // Start agent for this subtask
    const subtaskThreadId = await agentManager.startAgent(taskId, prompt, {
      workingDir: task.worktreePath || process.cwd(),
      onComplete: onSubtaskComplete,
    });

    await fs.appendFile(logsPath, `[Agent Started for Subtask] Thread ID: ${subtaskThreadId}\n`, 'utf-8');

    // Store the thread ID in task for potential cancellation
    const taskWithThread = await taskPersistence.loadTask(taskId);
    if (taskWithThread) {
      taskWithThread.assignedAgent = subtaskThreadId;
      await taskPersistence.saveTask(taskWithThread);
    }

    // Wait for this subtask to complete before moving to next
    // (The completion callback will handle marking it complete)
    await waitForSubtaskCompletion(taskId, i);
  }
}

/**
 * Wait for a subtask to complete
 */
async function waitForSubtaskCompletion(taskId: string, subtaskIndex: number): Promise<void> {
  return new Promise((resolve) => {
    let elapsed = 0;
    const maxWait = 60000; // 60 seconds max wait

    const interval = setInterval(async () => {
      elapsed += 500;

      // Timeout after max wait
      if (elapsed >= maxWait) {
        clearInterval(interval);
        console.error(`[waitForSubtaskCompletion] Timeout waiting for subtask ${subtaskIndex}`);
        resolve();
        return;
      }

      const task = await taskPersistence.loadTask(taskId);
      if (!task) {
        clearInterval(interval);
        resolve();
        return;
      }

      // Check if task is blocked or completed
      if (task.status === 'blocked' || task.status === 'completed') {
        clearInterval(interval);
        resolve();
        return;
      }

      // Check if subtask still exists at this index
      const subtask = task.subtasks[subtaskIndex];
      if (!subtask) {
        // Subtask was deleted
        clearInterval(interval);
        resolve();
        return;
      }

      // Check if subtask is completed
      if (subtask.status === 'completed') {
        clearInterval(interval);
        resolve();
      }
    }, 500); // Check every 500ms
  });
}
