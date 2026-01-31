/**
 * Auto-Plan Agent API Route
 *
 * Automatically plans a task and breaks it down into subtasks WITHOUT requiring human review.
 *
 * Flow:
 * 1. Generate plan directly (no questions)
 * 2. Auto-approve plan
 * 3. Generate subtasks
 * 4. Start sequential execution
 *
 * This enables fully autonomous task execution.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTaskPersistence } from '@/lib/tasks/persistence';
import { Subtask } from '@/lib/tasks/schema';
import { getAgentManagerForTask, startAgentForTask } from '@/lib/agents/registry';
import { getProjectDir } from '@/lib/project-dir';
import { cleanPlanningArtifactsFromWorktree } from '@/lib/worktree/cleanup';
import fs from 'fs/promises';
import path from 'path';

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

    // Check if task already has an agent assigned
    if (task.assignedAgent) {
      const mgr = await getAgentManagerForTask(task);
      const existingSession = mgr.getAgentStatus(task.assignedAgent);
      if (existingSession && existingSession.status === 'running') {
        return NextResponse.json({ error: 'Task already has an agent running' }, { status: 409 });
      }
    }

    // Ensure logs directory exists
    const logsPath = path.join(projectDir, '.code-auto', 'tasks', taskId, 'auto-plan-logs.txt');
    const logsDir = path.dirname(logsPath);
    await fs.mkdir(logsDir, { recursive: true });

    // Initialize log file
    await fs.writeFile(
      logsPath,
      `Auto-Plan started for task: ${task.title}\n` +
        `Task ID: ${taskId}\n` +
        `Description: ${task.description}\n` +
        `Started at: ${new Date().toISOString()}\n` +
        `${'='.repeat(80)}\n\n`,
      'utf-8'
    );

    await fs.appendFile(
      logsPath,
      `[Phase 1] Starting plan generation (no human review required)...\n`,
      'utf-8'
    );

    // Step 1: Generate plan directly (no questions asked)
    const planPrompt = buildPlanPrompt(task);

    const onPlanComplete = async (result: { success: boolean; output: string; error?: string }) => {
      await fs.appendFile(
        logsPath,
        `\n[Plan Generation Completed] Success: ${result.success}\n`,
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

      await fs.appendFile(logsPath, `[Plan Output]\n${result.output}\n`, 'utf-8');

      try {
        // Extract plan from output
        let planContent = result.output;

        // Try to extract markdown plan if it's in JSON
        try {
          const jsonMatch = result.output.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.plan) {
              planContent = parsed.plan;
            }
          }
        } catch {
          // Output is plain text plan, use as-is
        }

        await fs.appendFile(logsPath, `[Plan extracted successfully]\n`, 'utf-8');

        // Load current task and update with plan
        const currentTask = await taskPersistence.loadTask(taskId);
        if (!currentTask) return;

        currentTask.planContent = planContent;
        currentTask.planApproved = true; // Auto-approve since no human review
        currentTask.phase = 'in_progress';
        currentTask.status = 'in_progress';
        currentTask.assignedAgent = undefined;
        await taskPersistence.saveTask(currentTask);

        // Clean planning artifacts (agent may have written implementation-plan.json)
        await cleanPlanningArtifactsFromWorktree(currentTask.worktreePath || projectDir).catch(
          () => {}
        );

        await fs.appendFile(
          logsPath,
          `[Plan auto-approved]\n` +
            `${'='.repeat(80)}\n` +
            `[Phase 2] Starting subtask generation...\n` +
            `${'='.repeat(80)}\n\n`,
          'utf-8'
        );

        // Step 2: Generate subtasks from the plan
        const subtaskPrompt = buildSubtaskGenerationPrompt(currentTask);

        const onSubtasksComplete = async (subtaskResult: {
          success: boolean;
          output: string;
          error?: string;
        }) => {
          await fs.appendFile(
            logsPath,
            `\n[Subtask Generation Completed] Success: ${subtaskResult.success}\n`,
            'utf-8'
          );

          if (!subtaskResult.success) {
            await fs.appendFile(logsPath, `[Error] ${subtaskResult.error}\n`, 'utf-8');
            const taskToFail = await taskPersistence.loadTask(taskId);
            if (taskToFail) {
              taskToFail.status = 'blocked';
              taskToFail.assignedAgent = undefined;
              await taskPersistence.saveTask(taskToFail);
            }
            return;
          }

          await fs.appendFile(logsPath, `[Subtask Output]\n${subtaskResult.output}\n`, 'utf-8');

          try {
            // Parse subtasks
            const jsonMatch = subtaskResult.output.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
              throw new Error('No JSON found in output');
            }

            const parsedOutput = JSON.parse(jsonMatch[0]);

            if (!parsedOutput.subtasks || !Array.isArray(parsedOutput.subtasks)) {
              throw new Error('Invalid subtasks structure');
            }

            const subtasks: Subtask[] = parsedOutput.subtasks;

            // Validate each subtask
            for (const subtask of subtasks) {
              if (!subtask.id || !subtask.content || !subtask.label) {
                throw new Error(`Invalid subtask: missing required fields`);
              }
            }

            await fs.appendFile(logsPath, `[Validated ${subtasks.length} subtasks]\n`, 'utf-8');

            // Save subtasks to task
            const taskToUpdate = await taskPersistence.loadTask(taskId);
            if (!taskToUpdate) return;

            // Process subtasks
            const processedSubtasks = subtasks.map((s) => ({
              ...s,
              type: (s.type === 'qa' ? 'qa' : 'dev') as 'dev' | 'qa',
              status: 'pending' as const,
              activeForm: s.activeForm || `Working on ${s.label}`,
            }));

            // Separate dev and QA subtasks
            const devSubtasks = processedSubtasks.filter((s) => s.type === 'dev');
            const qaSubtasks = processedSubtasks.filter((s) => s.type === 'qa');

            // Auto-generate QA subtasks if none provided
            const finalQASubtasks =
              qaSubtasks.length > 0
                ? qaSubtasks
                : Array.from({ length: Math.floor(devSubtasks.length * 0.6) }, (_, i) => ({
                    id: `subtask-qa-${i + 1}`,
                    content: `[AUTO] Verify implementation step ${i + 1}`,
                    label: `Verify Step ${i + 1}`,
                    type: 'qa' as const,
                    status: 'pending' as const,
                    activeForm: `Verifying Step ${i + 1}`,
                  }));

            taskToUpdate.subtasks = [...devSubtasks, ...finalQASubtasks];
            taskToUpdate.assignedAgent = undefined;
            await taskPersistence.saveTask(taskToUpdate);

            // Clean planning artifacts before execution (ensure not in final output)
            await cleanPlanningArtifactsFromWorktree(taskToUpdate.worktreePath || projectDir).catch(
              () => {}
            );

            await fs.appendFile(
              logsPath,
              `[Subtasks saved]\n` +
                `- Dev subtasks: ${devSubtasks.length}\n` +
                `- QA subtasks: ${finalQASubtasks.length}\n` +
                `${'='.repeat(80)}\n` +
                `[PLAN COMPLETE] Task ready for execution\n` +
                `${'='.repeat(80)}\n`,
              'utf-8'
            );
          } catch (parseError) {
            await fs.appendFile(
              logsPath,
              `[Parse Error] ${parseError instanceof Error ? parseError.message : 'Unknown error'}\n`,
              'utf-8'
            );

            const taskToFail = await taskPersistence.loadTask(taskId);
            if (taskToFail) {
              taskToFail.status = 'blocked';
              taskToFail.assignedAgent = undefined;
              await taskPersistence.saveTask(taskToFail);
            }
          }
        };

        // Start subtask generation agent
        await fs.appendFile(logsPath, `[Starting Subtask Generation Agent]\n`, 'utf-8');

        const { threadId: subtaskThreadId } = await startAgentForTask({
          task: currentTask,
          prompt: subtaskPrompt,
          workingDir: currentTask.worktreePath || projectDir,
          projectDir,
          onComplete: onSubtasksComplete,
        });

        // Update task with agent
        currentTask.assignedAgent = subtaskThreadId;
        await taskPersistence.saveTask(currentTask);

        await fs.appendFile(
          logsPath,
          `[Subtask Agent Started] Thread ID: ${subtaskThreadId}\n`,
          'utf-8'
        );
      } catch (error) {
        await fs.appendFile(
          logsPath,
          `[Error during plan processing] ${error instanceof Error ? error.message : 'Unknown error'}\n`,
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

    // Start plan generation agent
    const { threadId: planThreadId } = await startAgentForTask({
      task,
      prompt: planPrompt,
      workingDir: task.worktreePath || projectDir,
      projectDir,
      onComplete: onPlanComplete,
    });

    // Update task status
    task.assignedAgent = planThreadId;
    task.status = 'planning';
    task.phase = 'planning';
    await taskPersistence.saveTask(task);

    await fs.appendFile(logsPath, `[Plan Agent Started] Thread ID: ${planThreadId}\n`, 'utf-8');

    return NextResponse.json({
      success: true,
      threadId: planThreadId,
      message: 'Auto-planning started - will generate plan and subtasks without human review',
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
 * Build prompt for direct plan generation (no questions asked)
 */
function buildPlanPrompt(task: { title: string; description: string }): string {
  return `You are an AI development assistant. Your task is to create a detailed implementation plan.

**Task:** ${task.title}
**Description:** ${task.description}

# PLANNING PHASE: Direct Plan Generation

Analyze the task and create a comprehensive, detailed implementation plan that covers:

1. **Overview** - Brief summary of what will be built
2. **Architecture** - High-level design and structure
3. **Implementation Steps** - Specific, actionable steps in order
4. **File Structure** - What files/directories will be created/modified
5. **Testing Strategy** - How the implementation will be tested
6. **Edge Cases** - Known edge cases and how to handle them

Guidelines:
- Be specific about file paths, functions, and code changes
- Structure the plan as clear, numbered steps
- Make the plan detailed enough for an AI developer to follow
- Include relevant technical details
- Consider dependencies and order of execution

Return your plan as clear markdown. Do NOT return JSON. Format it nicely with headers and bullet points.`;
}

/**
 * Build prompt for subtask generation from plan
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
- **activeForm**: Present continuous form for progress display (e.g., "Creating API endpoint")

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

CRITICAL: The system ONLY captures your text output. You MUST output the raw JSON as plain text in your message - writing to a file does NOT work. No markdown fences, no extra text.`;
}
