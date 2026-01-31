/**
 * Start Development API Route
 *
 * Task stays in planning phase until subtasks (dev + qa) are generated successfully.
 * 1. Generate subtasks from approved plan (task remains in planning)
 * 2. Parse & validate subtasks JSON (with fix-agent retry on failure)
 * 3. Only then move to in_progress and execute subtasks sequentially
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTaskPersistence, type TaskPersistence } from '@/lib/tasks/persistence';
import { Subtask } from '@/lib/tasks/schema';
import { startAgentForTask } from '@/lib/agents/registry';
import { getProjectDir } from '@/lib/project-dir';
import {
  extractAndValidateJSON,
  generateValidationFeedback,
  validateSubtasks,
} from '@/lib/validation/subtask-validator';
import fs from 'fs/promises';
import path from 'path';

const MAX_PARSE_RETRIES = 2; // Initial parse + up to 2 fix-agent attempts

export async function POST(req: NextRequest) {
  try {
    const projectDir = await getProjectDir(req);
    const taskPersistence = getTaskPersistence(projectDir);

    const { taskId } = await req.json();

    if (!taskId) {
      return NextResponse.json({ error: 'taskId required' }, { status: 400 });
    }

    // Load task
    const task = await taskPersistence.loadTask(taskId);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Check if task has approved plan
    if (!task.planApproved || !task.planContent) {
      return NextResponse.json(
        { error: 'Task must have an approved plan before starting development' },
        { status: 400 }
      );
    }

    // Ensure development logs directory exists
    const logsPath = path.join(projectDir, '.code-auto', 'tasks', taskId, 'development-logs.txt');
    const logsDir = path.dirname(logsPath);
    await fs.mkdir(logsDir, { recursive: true });

    // Initialize log file
    await fs.writeFile(
      logsPath,
      `Subtask generation started for task: ${task.title}\n` +
        `Task ID: ${taskId}\n` +
        `Started at: ${new Date().toISOString()}\n` +
        `(Task remains in planning until subtasks are generated successfully)\n` +
        `${'='.repeat(80)}\n\n`,
      'utf-8'
    );

    // Build subtask generation prompt
    const prompt = buildSubtaskGenerationPrompt(task);

    // Create completion handler with parse-retry loop (fix agent when JSON/validation fails)
    const createOnSubtasksGenerated = (parseAttempt: number) => {
      return async (result: { success: boolean; output: string; error?: string }) => {
        const isFixAttempt = parseAttempt > 0;
        await fs.appendFile(
          logsPath,
          `\n[${isFixAttempt ? 'Fix Agent' : 'Subtask Generation'} Completed] Success: ${result.success}\n`,
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

        // Parse and validate subtasks JSON
        try {
          const { data: parsedOutput, error: jsonError } = extractAndValidateJSON(result.output);
          if (jsonError || !parsedOutput) {
            throw new Error(jsonError || 'No JSON found in output');
          }
          await fs.appendFile(logsPath, `[Parsed JSON successfully]\n`, 'utf-8');

          // Validate subtasks structure
          const validation = validateSubtasks(parsedOutput);
          if (!validation.valid) {
            const feedback = generateValidationFeedback(validation);
            throw new Error(feedback);
          }

          const subtasks: Subtask[] = (parsedOutput?.subtasks ?? []) as Subtask[];

          await fs.appendFile(logsPath, `[Validated ${subtasks.length} subtasks]\n`, 'utf-8');

          // Save subtasks to task - NOW move to in_progress (subtasks generated successfully)
          const currentTask = await taskPersistence.loadTask(taskId);
          if (!currentTask) return;

          // Process subtasks from CLI.
          const processedSubtasks = subtasks.map((s) => {
            const type: 'dev' | 'qa' = inferSubtaskType(s);
            return {
              ...s,
              type,
              status: 'pending' as const,
              activeForm: s.activeForm || `Working on ${s.label}`,
            };
          });

          const devSubtasks = processedSubtasks.filter((s) => s.type === 'dev');
          const qaSubtasks = processedSubtasks.filter((s) => s.type === 'qa');

          const finalQASubtasks =
            qaSubtasks.length > 0
              ? qaSubtasks
              : Array.from({ length: Math.floor(devSubtasks.length * 0.6) }, (_, i) => ({
                  id: `subtask-qa-${i + 1}`,
                  content: `[AUTO] Verify implementation step ${i + 1} - Validate the corresponding development work`,
                  label: `Verify Step ${i + 1}`,
                  type: 'qa' as const,
                  status: 'pending' as const,
                  activeForm: `Verifying Step ${i + 1}`,
                }));

          currentTask.subtasks = [...devSubtasks, ...finalQASubtasks];
          currentTask.phase = 'in_progress'; // Only now move to development
          currentTask.status = 'in_progress';
          currentTask.assignedAgent = undefined;
          await taskPersistence.saveTask(currentTask);

          await fs.appendFile(logsPath, `[Subtasks saved to task]\n`, 'utf-8');

          // Start sequential execution
          await fs.appendFile(
            logsPath,
            `\n${'='.repeat(80)}\n[Starting Sequential Execution]\n${'='.repeat(80)}\n\n`,
            'utf-8'
          );

          await executeSubtasksSequentially(
            taskPersistence,
            projectDir,
            taskId,
            devSubtasks,
            logsPath
          );
        } catch (parseError) {
          const errMsg = parseError instanceof Error ? parseError.message : 'Unknown error';
          await fs.appendFile(logsPath, `[Parse/Validation Error] ${errMsg}\n`, 'utf-8');

          // Retry: run fix agent to repair the output
          if (parseAttempt < MAX_PARSE_RETRIES) {
            await fs.appendFile(
              logsPath,
              `\n[Parse Retry] Attempt ${parseAttempt + 1}/${MAX_PARSE_RETRIES} - Starting fix agent...\n`,
              'utf-8'
            );

            const fixPrompt = `Your previous response could not be parsed or validated as valid subtasks JSON.

Error: ${errMsg}

Here is your previous output (it may contain markdown fences, extra text, or invalid JSON - extract and fix it):

---
${result.output}
---

Your task: Extract the subtasks from the output above and return ONLY valid JSON with no markdown fences, no extra text.

Required format:
{
  "subtasks": [
    {
      "id": "subtask-1",
      "content": "Detailed description of work",
      "label": "Short label",
      "activeForm": "Optional: present continuous form",
      "type": "dev" or "qa"
    }
  ]
}

Rules:
- Each subtask must have id, content, label (all non-empty strings)
- Include at least 2 QA subtasks (type: "qa") for verification/testing
- Escape any quotes inside strings (use \\" for literal quotes)
- Do not wrap the JSON in \`\`\`json code blocks
- Return nothing else - only the JSON object`;

            const currentTask = await taskPersistence.loadTask(taskId);
            if (!currentTask) return;

            const { threadId: fixThreadId } = await startAgentForTask({
              task: currentTask,
              prompt: fixPrompt,
              workingDir: currentTask.worktreePath || projectDir,
              projectDir,
              onComplete: createOnSubtasksGenerated(parseAttempt + 1),
            });

            currentTask.assignedAgent = fixThreadId;
            currentTask.status = 'planning'; // Stay in planning during retry
            currentTask.phase = 'planning';
            await taskPersistence.saveTask(currentTask);
            await fs.appendFile(
              logsPath,
              `[Fix Agent Started] Thread ID: ${fixThreadId}\n`,
              'utf-8'
            );
          } else {
            // Max retries reached - block the task (stays in planning)
            const currentTask = await taskPersistence.loadTask(taskId);
            if (currentTask) {
              currentTask.status = 'blocked';
              currentTask.assignedAgent = undefined;
              await taskPersistence.saveTask(currentTask);
            }
            await fs.appendFile(
              logsPath,
              `[Max Parse Retries Reached] Task blocked. Subtasks could not be parsed/validated.\n`,
              'utf-8'
            );
          }
        }
      };
    };

    // Start subtask generation agent
    await fs.appendFile(logsPath, `[Starting Subtask Generation Agent]\n`, 'utf-8');

    const { threadId } = await startAgentForTask({
      task,
      prompt,
      workingDir: task.worktreePath || projectDir,
      projectDir,
      onComplete: createOnSubtasksGenerated(0),
    });

    // Keep task in planning phase until subtasks are generated successfully
    task.assignedAgent = threadId;
    task.status = 'planning';
    task.phase = 'planning';
    await taskPersistence.saveTask(task);

    await fs.appendFile(logsPath, `[Agent Started] Thread ID: ${threadId}\n`, 'utf-8');

    return NextResponse.json({
      success: true,
      threadId,
      message: 'Generating subtasks - task remains in planning until subtasks are ready',
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
function buildSubtaskGenerationPrompt(task: {
  title: string;
  description: string;
  planContent?: string;
}): string {
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

====================
CRITICAL FINAL INSTRUCTION:
====================
After you analyze the plan and formulate your subtasks, you MUST output a final response containing ONLY the JSON object above.

Your LAST message must be the raw JSON with NO:
- Markdown code fences (\`\`\`json)
- Explanatory text before or after
- Comments or additional formatting

Just the pure JSON object starting with { and ending with }.

Example of what your final output should look like:
{"subtasks":[{"id":"subtask-1","content":"...","label":"...","activeForm":"...","type":"dev"}]}
====================`;
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
    'yarn build',
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
async function executeSubtasksSequentially(
  taskPersistence: TaskPersistence,
  projectDir: string,
  taskId: string,
  subtasks: Subtask[],
  logsPath: string
) {
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
    const onSubtaskComplete = async (result: {
      success: boolean;
      output: string;
      error?: string;
    }) => {
      await fs.appendFile(
        logsPath,
        `\n[Subtask ${i + 1} Completed] Success: ${result.success}\n`,
        'utf-8'
      );

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
          await fs.appendFile(
            logsPath,
            `\n${'='.repeat(80)}\n[ALL DEV SUBTASKS COMPLETED - Moving to AI Review]\n${'='.repeat(80)}\n`,
            'utf-8'
          );

          // Automatically start AI review
          await fs.appendFile(logsPath, `\n[AUTO] Initiating AI Review Phase...\n`, 'utf-8');
          startAIReviewAutomatically(taskPersistence, projectDir, currentTask.id, logsPath);
        }

        await taskPersistence.saveTask(currentTask);
      }
    };

    // Start agent for this subtask
    const { threadId: subtaskThreadId } = await startAgentForTask({
      task,
      prompt,
      workingDir: task.worktreePath || projectDir,
      projectDir,
      onComplete: onSubtaskComplete,
    });

    await fs.appendFile(
      logsPath,
      `[Agent Started for Subtask] Thread ID: ${subtaskThreadId}\n`,
      'utf-8'
    );

    // Store the thread ID in task for potential cancellation
    const taskWithThread = await taskPersistence.loadTask(taskId);
    if (taskWithThread) {
      taskWithThread.assignedAgent = subtaskThreadId;
      await taskPersistence.saveTask(taskWithThread);
    }

    // Wait for this subtask to complete before moving to next
    await waitForSubtaskCompletion(taskPersistence, taskId, subtask.id);
  }
}

/**
 * Wait for a subtask to complete
 */
async function waitForSubtaskCompletion(
  taskPersistence: TaskPersistence,
  taskId: string,
  subtaskId: string
): Promise<void> {
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
function startAIReviewAutomatically(
  taskPersistence: TaskPersistence,
  projectDir: string,
  taskId: string,
  devLogsPath: string
): void {
  // Fire and forget - don't await
  // This allows the dev phase to finish while review starts in background
  setTimeout(async () => {
    try {
      await fs.appendFile(devLogsPath, `[AUTO] Triggering AI Review Phase...\n`, 'utf-8');

      const task = await taskPersistence.loadTask(taskId);
      if (!task || task.phase !== 'ai_review') {
        await fs.appendFile(
          devLogsPath,
          `[AUTO] Cannot start review - task not in ai_review phase\n`,
          'utf-8'
        );
        return;
      }

      // Create review logs path
      const reviewLogsPath = path.join(
        projectDir,
        '.code-auto',
        'tasks',
        taskId,
        'review-logs.txt'
      );
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

      await fs.appendFile(
        reviewLogsPath,
        `[Starting Sequential QA Verification]\n${'='.repeat(80)}\n\n`,
        'utf-8'
      );

      // Execute QA subtasks
      const qaSubtasks = task.subtasks.filter((s) => s.type === 'qa');
      await executeQASubtasksSequentially(
        taskPersistence,
        projectDir,
        taskId,
        qaSubtasks,
        reviewLogsPath
      );

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
async function executeQASubtasksSequentially(
  taskPersistence: TaskPersistence,
  projectDir: string,
  taskId: string,
  qaSubtasks: Subtask[],
  logsPath: string
) {
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
    const onSubtaskComplete = async (result: {
      success: boolean;
      output: string;
      error?: string;
    }) => {
      await fs.appendFile(
        logsPath,
        `\n[QA Subtask ${count + 1} Completed] Success: ${result.success}\n`,
        'utf-8'
      );

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
          await fs.appendFile(
            logsPath,
            `\n${'='.repeat(80)}\n[ALL QA SUBTASKS COMPLETED - Moving to Human Review]\n${'='.repeat(80)}\n`,
            'utf-8'
          );
        }

        await taskPersistence.saveTask(currentTask);
      }
    };

    // Start agent for this QA subtask
    const { threadId: subtaskThreadId } = await startAgentForTask({
      task,
      prompt,
      workingDir: task.worktreePath || projectDir,
      projectDir,
      onComplete: onSubtaskComplete,
    });

    await fs.appendFile(
      logsPath,
      `[Agent Started for QA Subtask] Thread ID: ${subtaskThreadId}\n`,
      'utf-8'
    );

    // Store the thread ID in task for potential cancellation
    const taskWithThread = await taskPersistence.loadTask(taskId);
    if (taskWithThread) {
      taskWithThread.assignedAgent = subtaskThreadId;
      await taskPersistence.saveTask(taskWithThread);
    }

    // Wait for this subtask to complete before moving to next
    await waitForQASubtaskCompletion(taskPersistence, taskId, subtask.id);
  }
}

/**
 * Wait for QA subtask to complete
 */
async function waitForQASubtaskCompletion(
  taskPersistence: TaskPersistence,
  taskId: string,
  subtaskId: string
): Promise<void> {
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
