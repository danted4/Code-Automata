/**
 * Start Development API Route
 *
 * Starts development phase:
 * 1. Generate subtasks from approved plan
 * 2. Validate subtasks JSON
 * 3. Execute subtasks sequentially
 */

import { NextRequest, NextResponse } from 'next/server';
import { taskPersistence } from '@/lib/tasks/persistence';
import { Subtask } from '@/lib/tasks/schema';
import { startAgentForTask } from '@/lib/agents/registry';
import { extractAndValidateJSON, generateValidationFeedback, validateSubtasks } from '@/lib/validation/subtask-validator';
import fs from 'fs/promises';
import path from 'path';

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
        const { data: parsedOutput, error: jsonError } = extractAndValidateJSON(result.output);
        if (jsonError) throw new Error(jsonError);
        await fs.appendFile(logsPath, `[Parsed JSON successfully]\n`, 'utf-8');

        // Validate subtasks structure
        const validation = validateSubtasks(parsedOutput);
        if (!validation.valid) {
          const feedback = generateValidationFeedback(validation);
          throw new Error(feedback);
        }

        const subtasks: Subtask[] = parsedOutput.subtasks;

        await fs.appendFile(logsPath, `[Validated ${subtasks.length} subtasks]\n`, 'utf-8');

        // Save subtasks to task
        const currentTask = await taskPersistence.loadTask(taskId);
        if (!currentTask) return;

        // Process subtasks from CLI.
        // Prefer explicit type if provided; otherwise infer "qa" for validation/testing/build steps.
        const processedSubtasks = subtasks.map(s => {
          const type: 'dev' | 'qa' = inferSubtaskType(s);
          return {
            ...s,
            type,
            status: 'pending' as const,
            activeForm: s.activeForm || `Working on ${s.label}`,
          };
        });

        // Separate dev and QA subtasks
        const devSubtasks = processedSubtasks.filter(s => s.type === 'dev');
        const qaSubtasks = processedSubtasks.filter(s => s.type === 'qa');

        // If no QA subtasks came from CLI/inference, generate them (~60% of dev count)
        const finalQASubtasks = qaSubtasks.length > 0 ? qaSubtasks : Array.from({ length: Math.floor(devSubtasks.length * 0.6) }, (_, i) => ({
          id: `subtask-qa-${i + 1}`,
          content: `[AUTO] Verify implementation step ${i + 1} - Validate the corresponding development work`,
          label: `Verify Step ${i + 1}`,
          type: 'qa' as const,
          status: 'pending' as const,
          activeForm: `Verifying Step ${i + 1}`,
        }));

        currentTask.subtasks = [...devSubtasks, ...finalQASubtasks];
        currentTask.status = 'in_progress';
        currentTask.assignedAgent = undefined; // Clear agent after subtask generation
        await taskPersistence.saveTask(currentTask);

        await fs.appendFile(logsPath, `[Subtasks saved to task]\n`, 'utf-8');

        // Start sequential execution
        await fs.appendFile(logsPath, `\n${'='.repeat(80)}\n[Starting Sequential Execution]\n${'='.repeat(80)}\n\n`, 'utf-8');

        // Execute DEV subtasks one by one (QA runs later in ai_review)
        await executeSubtasksSequentially(taskId, devSubtasks, logsPath);

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

    const { threadId } = await startAgentForTask({
      task,
      prompt,
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
- **type**: Either "dev" or "qa"

**Guidelines:**
1. Break down complex steps into smaller, manageable subtasks
2. Each subtask should be completable independently
3. Order subtasks logically (dependencies first)
4. Be specific about files, functions, and changes needed
5. Cap at 15 subtasks maximum
6. Include at least 2 QA subtasks ("type": "qa") that ONLY verify/test (e.g. run build/tests, validate docs/links/diagrams)
7. Put verification steps (build/test/lint/validate/verify) under QA, not dev

Return your subtasks in the following JSON format:
{
  "subtasks": [
    {
      "id": "subtask-1",
      "content": "Create the API route file at src/app/api/example/route.ts with POST endpoint handler",
      "label": "Create API endpoint",
      "activeForm": "Creating API endpoint",
      "type": "dev"
    },
    {
      "id": "subtask-2",
      "content": "Add input validation using Zod schema for request body parameters",
      "label": "Add input validation",
      "activeForm": "Adding input validation",
      "type": "dev"
    },
    {
      "id": "subtask-qa-1",
      "content": "Run the build and verify there are no errors; if there are, report them clearly without changing code",
      "label": "Verify build",
      "activeForm": "Verifying build",
      "type": "qa"
    }
  ]
}

IMPORTANT: Return ONLY valid JSON. Do not include any markdown formatting or additional text.`;
}

function inferSubtaskType(subtask: Partial<Subtask>): 'dev' | 'qa' {
  if (subtask.type === 'qa') return 'qa';
  if (subtask.type === 'dev') return 'dev';

  const haystack = `${subtask.label || ''} ${subtask.content || ''}`.toLowerCase();
  const qaSignals = [
    'validate',
    'verification',
    'verify',
    'qa',
    'test',
    'tests',
    'unit test',
    'integration',
    'e2e',
    'lint',
    'typecheck',
    'type check',
    'pnpm build',
    'npm run build',
    'run build',
    'build passes',
    'check diagrams',
    'mermaid',
    'cross-check',
    'cross check',
    'review',
  ];
  if (qaSignals.some((s) => haystack.includes(s))) return 'qa';
  return 'dev';
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

    const taskSubtaskIndex = task.subtasks.findIndex((s) => s.id === subtask.id);
    if (taskSubtaskIndex === -1) {
      await fs.appendFile(
        logsPath,
        `\n${'='.repeat(80)}\n[Subtask ${i + 1}/${subtasks.length}] ${subtask.label} - SKIPPED (deleted)\n${'='.repeat(80)}\n\n`,
        'utf-8'
      );
      continue;
    }

    // Safety: dev phase should only execute dev subtasks
    if (task.subtasks[taskSubtaskIndex].type !== 'dev') {
      await fs.appendFile(
        logsPath,
        `\n${'='.repeat(80)}\n[Subtask ${i + 1}/${subtasks.length}] ${subtask.label} - SKIPPED (not dev)\n${'='.repeat(80)}\n\n`,
        'utf-8'
      );
      continue;
    }

    // Check if this subtask was already completed (e.g., skipped by user)
    if (task.subtasks[taskSubtaskIndex].status === 'completed') {
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
    task.subtasks[taskSubtaskIndex].status = 'in_progress';
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
          const idx = currentTask.subtasks.findIndex((s) => s.id === subtask.id);
          if (idx !== -1) {
            currentTask.subtasks[idx].status = 'pending'; // Reset to pending on error
          }
          currentTask.status = 'blocked';
          await taskPersistence.saveTask(currentTask);
        }
        return;
      }

      await fs.appendFile(logsPath, `[Output]\n${result.output}\n`, 'utf-8');

      // Mark subtask as completed
      const currentTask = await taskPersistence.loadTask(taskId);
      if (currentTask) {
        const idx = currentTask.subtasks.findIndex((s) => s.id === subtask.id);
        if (idx !== -1) {
          currentTask.subtasks[idx].status = 'completed';
        }

        // Check if all DEV subtasks are completed
        const allDevCompleted = currentTask.subtasks
          .filter((s) => s.type === 'dev')
          .every((s) => s.status === 'completed');

        if (allDevCompleted && currentTask.phase === 'in_progress') {
          currentTask.phase = 'ai_review'; // Move to AI review phase
          currentTask.assignedAgent = undefined; // Clear agent
          await fs.appendFile(logsPath, `\n${'='.repeat(80)}\n[ALL DEV SUBTASKS COMPLETED - Moving to AI Review]\n${'='.repeat(80)}\n`, 'utf-8');

          // Automatically start AI review
          await fs.appendFile(logsPath, `\n[AUTO] Initiating AI Review Phase...\n`, 'utf-8');
          startAIReviewAutomatically(currentTask.id, logsPath);
        }

        await taskPersistence.saveTask(currentTask);
      }
    };

    // Start agent for this subtask
    const { threadId: subtaskThreadId } = await startAgentForTask({
      task,
      prompt,
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
    await waitForSubtaskCompletion(taskId, subtask.id);
  }
}

/**
 * Wait for a subtask to complete
 */
async function waitForSubtaskCompletion(taskId: string, subtaskId: string): Promise<void> {
  return new Promise((resolve) => {
    let elapsed = 0;
    const configured = Number(process.env.CODE_AUTO_SUBTASK_WAIT_MS || '');
    const maxWait = Number.isFinite(configured) && configured > 0 ? configured : 30 * 60 * 1000; // 30 min default

    const interval = setInterval(async () => {
      elapsed += 1000;

      // Timeout after max wait
      if (elapsed >= maxWait) {
        clearInterval(interval);
        console.error(`[waitForSubtaskCompletion] Timeout waiting for subtask ${subtaskId}`);
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

      // Check if subtask still exists
      const subtask = task.subtasks.find((s) => s.id === subtaskId);
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
    }, 1000); // Check every 1s
  });
}

/**
 * Automatically start AI review phase after dev subtasks complete
 * Triggers the review process via background job without waiting
 */
function startAIReviewAutomatically(taskId: string, devLogsPath: string): void {
  // Fire and forget - don't await
  // This allows the dev phase to finish while review starts in background
  setTimeout(async () => {
    try {
      await fs.appendFile(devLogsPath, `[AUTO] Triggering AI Review Phase...\n`, 'utf-8');
      
      const task = await taskPersistence.loadTask(taskId);
      if (!task || task.phase !== 'ai_review') {
        await fs.appendFile(devLogsPath, `[AUTO] Cannot start review - task not in ai_review phase\n`, 'utf-8');
        return;
      }

      // Create review logs path
      const reviewLogsPath = `.code-auto/tasks/${taskId}/review-logs.txt`;
      const logsDir = path.dirname(reviewLogsPath);
      await fs.mkdir(logsDir, { recursive: true });

      await fs.writeFile(
        reviewLogsPath,
        `AI Review auto-started for task: ${task.title}\n` +
        `Task ID: ${taskId}\n` +
        `Started at: ${new Date().toISOString()}\n` +
        `${'='.repeat(80)}\n\n`,
        'utf-8'
      );

      await fs.appendFile(reviewLogsPath, `[Starting Sequential QA Verification]\n${'='.repeat(80)}\n\n`, 'utf-8');

      // Execute QA subtasks
      const qaSubtasks = task.subtasks.filter((s) => s.type === 'qa');
      await executeQASubtasksSequentially(taskId, qaSubtasks, reviewLogsPath);
      
      await fs.appendFile(devLogsPath, `[AUTO] AI Review Phase initiated\n`, 'utf-8');
    } catch (error) {
      await fs.appendFile(
        devLogsPath,
        `[AUTO] Error initiating AI review: ${error instanceof Error ? error.message : 'Unknown'}\n`,
        'utf-8'
      );
    }
  }, 1000); // Give 1 second for phase transition to be saved
}

/**
 * Execute QA subtasks sequentially (auto-triggered after dev completion)
 */
async function executeQASubtasksSequentially(taskId: string, qaSubtasks: Subtask[], logsPath: string) {
  for (let count = 0; count < qaSubtasks.length; count++) {
    const subtask = qaSubtasks[count];

    // Load fresh task data to check current status
    const task = await taskPersistence.loadTask(taskId);
    if (!task) return;

    const taskSubtaskIndex = task.subtasks.findIndex((s) => s.id === subtask.id);
    if (taskSubtaskIndex === -1) {
      await fs.appendFile(
        logsPath,
        `\n${'='.repeat(80)}\n[QA Subtask ${count + 1}/${qaSubtasks.length}] ${subtask.label} - SKIPPED (deleted)\n${'='.repeat(80)}\n\n`,
        'utf-8'
      );
      continue;
    }

    // Safety: QA phase should only execute QA subtasks
    if (task.subtasks[taskSubtaskIndex].type !== 'qa') {
      await fs.appendFile(
        logsPath,
        `\n${'='.repeat(80)}\n[QA Subtask ${count + 1}/${qaSubtasks.length}] ${subtask.label} - SKIPPED (not qa)\n${'='.repeat(80)}\n\n`,
        'utf-8'
      );
      continue;
    }

    // Check if this subtask was already completed (e.g., skipped by user)
    if (task.subtasks[taskSubtaskIndex].status === 'completed') {
      await fs.appendFile(
        logsPath,
        `\n${'='.repeat(80)}\n[QA Subtask ${count + 1}/${qaSubtasks.length}] ${subtask.label} - SKIPPED (already completed)\n${'='.repeat(80)}\n\n`,
        'utf-8'
      );
      continue;
    }

    await fs.appendFile(
      logsPath,
      `\n${'='.repeat(80)}\n[QA Subtask ${count + 1}/${qaSubtasks.length}] ${subtask.label}\n${'='.repeat(80)}\n\n`,
      'utf-8'
    );

    // Update subtask to in_progress
    task.subtasks[taskSubtaskIndex].status = 'in_progress';
    await taskPersistence.saveTask(task);

    // Execute subtask
    const prompt = `Execute the following QA verification subtask:

**QA Subtask:** ${subtask.label}
**Details:** ${subtask.content}

Please verify and test this thoroughly following best practices.`;

    // Create completion handler for this subtask
    const onSubtaskComplete = async (result: { success: boolean; output: string; error?: string }) => {
      await fs.appendFile(logsPath, `\n[QA Subtask ${count + 1} Completed] Success: ${result.success}\n`, 'utf-8');

      if (!result.success) {
        await fs.appendFile(logsPath, `[Error] ${result.error}\n`, 'utf-8');

        const currentTask = await taskPersistence.loadTask(taskId);
        if (currentTask) {
          const idx = currentTask.subtasks.findIndex((s) => s.id === subtask.id);
          if (idx !== -1) {
            currentTask.subtasks[idx].status = 'pending';
          }
          currentTask.status = 'blocked';
          await taskPersistence.saveTask(currentTask);
        }
        return;
      }

      await fs.appendFile(logsPath, `[Output]\n${result.output}\n`, 'utf-8');

      // Mark subtask as completed
      const currentTask = await taskPersistence.loadTask(taskId);
      if (currentTask) {
        const idx = currentTask.subtasks.findIndex((s) => s.id === subtask.id);
        if (idx !== -1) {
          currentTask.subtasks[idx].status = 'completed';
        }

        // Check if all QA subtasks are completed
        const allQACompleted = currentTask.subtasks
          .filter((s) => s.type === 'qa')
          .every((s) => s.status === 'completed');

        if (allQACompleted && currentTask.phase === 'ai_review') {
          currentTask.phase = 'human_review';
          currentTask.status = 'completed';
          currentTask.assignedAgent = undefined;
          await fs.appendFile(logsPath, `\n${'='.repeat(80)}\n[ALL QA SUBTASKS COMPLETED - Moving to Human Review]\n${'='.repeat(80)}\n`, 'utf-8');
        }

        await taskPersistence.saveTask(currentTask);
      }
    };

    // Start agent for this QA subtask
    const { threadId: subtaskThreadId } = await startAgentForTask({
      task,
      prompt,
      workingDir: task.worktreePath || process.cwd(),
      onComplete: onSubtaskComplete,
    });

    await fs.appendFile(logsPath, `[Agent Started for QA Subtask] Thread ID: ${subtaskThreadId}\n`, 'utf-8');

    // Store the thread ID in task for potential cancellation
    const taskWithThread = await taskPersistence.loadTask(taskId);
    if (taskWithThread) {
      taskWithThread.assignedAgent = subtaskThreadId;
      await taskPersistence.saveTask(taskWithThread);
    }

    // Wait for this subtask to complete before moving to next
    await waitForQASubtaskCompletion(taskId, subtask.id);
  }
}

/**
 * Wait for QA subtask to complete
 */
async function waitForQASubtaskCompletion(taskId: string, subtaskId: string): Promise<void> {
  return new Promise((resolve) => {
    let elapsed = 0;
    const configured = Number(process.env.CODE_AUTO_SUBTASK_WAIT_MS || '');
    const maxWait = Number.isFinite(configured) && configured > 0 ? configured : 30 * 60 * 1000; // 30 min default

    const interval = setInterval(async () => {
      elapsed += 1000;

      if (elapsed >= maxWait) {
        clearInterval(interval);
        console.error(`[waitForQASubtaskCompletion] Timeout waiting for QA subtask ${subtaskId}`);
        resolve();
        return;
      }

      const task = await taskPersistence.loadTask(taskId);
      if (!task) {
        clearInterval(interval);
        resolve();
        return;
      }

      if (task.status === 'blocked' || task.status === 'completed') {
        clearInterval(interval);
        resolve();
        return;
      }

      const subtask = task.subtasks.find((s) => s.id === subtaskId);
      if (!subtask) {
        clearInterval(interval);
        resolve();
        return;
      }

      if (subtask.status === 'completed') {
        clearInterval(interval);
        resolve();
      }
    }, 1000);
  });
}
