/**
 * Submit Planning Answers API Route
 *
 * Receives answers to planning questions and triggers plan generation.
 * When JSON extraction fails, runs a fix agent to repair the output (up to MAX_PARSE_RETRIES).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTaskPersistence } from '@/lib/tasks/persistence';
import { startAgentForTask } from '@/lib/agents/registry';
import { getProjectDir } from '@/lib/project-dir';
import { extractAndValidateJSON } from '@/lib/validation/subtask-validator';
import fs from 'fs/promises';
import path from 'path';

const MAX_PARSE_RETRIES = 2; // Initial parse + up to 2 fix-agent attempts

export async function POST(req: NextRequest) {
  try {
    const projectDir = await getProjectDir(req);
    const taskPersistence = getTaskPersistence(projectDir);

    const { taskId, answers } = await req.json();

    if (!taskId || !answers) {
      return NextResponse.json({ error: 'taskId and answers required' }, { status: 400 });
    }

    // Load task
    const task = await taskPersistence.loadTask(taskId);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Update task with answers
    if (task.planningData) {
      task.planningData.questions = task.planningData.questions.map((q) => ({
        ...q,
        answer: answers[q.id] || { selectedOption: '', additionalText: '' },
      }));
      task.planningData.answeredAt = Date.now();
      task.planningData.status = 'completed';
    }

    task.planningStatus = 'generating_plan';
    await taskPersistence.saveTask(task);

    // Log to planning logs
    const logsPath = task.planningLogsPath
      ? path.isAbsolute(task.planningLogsPath)
        ? task.planningLogsPath
        : path.join(projectDir, task.planningLogsPath)
      : path.join(projectDir, '.code-auto', 'tasks', taskId, 'planning-logs.txt');
    await fs.appendFile(
      logsPath,
      `\n${'='.repeat(80)}\n` +
        `[Answers Submitted] ${new Date().toISOString()}\n` +
        `${Object.entries(answers)
          .map(([qId, answer]) => {
            const a = answer as { selectedOption?: string; additionalText?: string };
            const question = task.planningData?.questions.find((q) => q.id === qId);
            return (
              `\nQ${question?.order || '?'}: ${question?.question || qId}\n` +
              `A: ${a.selectedOption}\n` +
              (a.additionalText ? `Additional: ${a.additionalText}\n` : '')
            );
          })
          .join('')}\n` +
        `${'='.repeat(80)}\n\n`,
      'utf-8'
    );

    // Build plan generation prompt with answers
    const prompt = buildPlanGenerationPrompt(task, answers);

    // Create completion handler with parse-retry loop (fix agent when JSON extraction fails)
    const createOnComplete = (parseAttempt: number) => {
      return async (result: { success: boolean; output: string; error?: string }) => {
        const isFixAttempt = parseAttempt > 0;
        await fs.appendFile(
          logsPath,
          `\n[${isFixAttempt ? 'Fix Agent' : 'Plan Generation'} Completed] Success: ${result.success}\n`,
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

        // Parse JSON output (handles markdown code blocks and nested braces in plan content)
        try {
          const { data: parsedOutput, error: jsonError } = extractAndValidateJSON(result.output);
          if (jsonError || !parsedOutput) {
            throw new Error(jsonError || 'No JSON found in output');
          }
          await fs.appendFile(logsPath, `[Parsed JSON successfully]\n`, 'utf-8');

          const currentTask = await taskPersistence.loadTask(taskId);
          if (!currentTask) return;

          const planContent = (parsedOutput as { plan?: string }).plan;
          if (planContent) {
            await fs.appendFile(logsPath, `[Plan Generated]\n`, 'utf-8');

            currentTask.planContent = planContent;
            currentTask.planningStatus = 'plan_ready';
            currentTask.status = 'pending';
            currentTask.assignedAgent = undefined;

            await taskPersistence.saveTask(currentTask);
            await fs.appendFile(logsPath, `[Task Updated Successfully]\n`, 'utf-8');
            return;
          }
          throw new Error('Parsed JSON has no "plan" field');
        } catch (parseError) {
          const errMsg = parseError instanceof Error ? parseError.message : 'Unknown error';
          await fs.appendFile(logsPath, `[Parse Error] Failed to parse JSON: ${errMsg}\n`, 'utf-8');

          // Retry: run fix agent to repair the output
          if (parseAttempt < MAX_PARSE_RETRIES) {
            await fs.appendFile(
              logsPath,
              `\n[Parse Retry] Attempt ${parseAttempt + 1}/${MAX_PARSE_RETRIES} - Starting fix agent...\n`,
              'utf-8'
            );

            const fixPrompt = `Your previous response could not be parsed as valid JSON.

Parse error: ${errMsg}

Here is your previous output (it may contain markdown fences, extra text, or invalid JSON - extract and fix it):

---
${result.output}
---

Your task: Extract the implementation plan from the output above and return ONLY valid JSON with no markdown fences, no extra text.

Required format:
{
  "plan": "<markdown string - the full implementation plan content>"
}

Rules:
- Escape any quotes inside the plan string (use \\" for literal quotes)
- Do not wrap the JSON in \`\`\`json code blocks
- Return nothing else - only the JSON object`;

            const currentTask = await taskPersistence.loadTask(taskId);
            if (!currentTask) return;

            const { threadId: fixThreadId } = await startAgentForTask({
              task: currentTask,
              prompt: fixPrompt,
              workingDir: currentTask.worktreePath || projectDir,
              projectDir,
              onComplete: createOnComplete(parseAttempt + 1),
            });

            currentTask.assignedAgent = fixThreadId;
            currentTask.status = 'planning';
            currentTask.planningStatus = 'generating_plan';
            await taskPersistence.saveTask(currentTask);
            await fs.appendFile(
              logsPath,
              `[Fix Agent Started] Thread ID: ${fixThreadId}\n`,
              'utf-8'
            );
          } else {
            // Max retries reached - block the task
            const currentTask = await taskPersistence.loadTask(taskId);
            if (currentTask) {
              currentTask.status = 'blocked';
              currentTask.assignedAgent = undefined;
              await taskPersistence.saveTask(currentTask);
            }
            await fs.appendFile(logsPath, `[Max Parse Retries Reached] Task blocked.\n`, 'utf-8');
          }
        }
      };
    };

    const onComplete = createOnComplete(0);

    // Start plan generation agent
    await fs.appendFile(logsPath, `[Starting Plan Generation]\n`, 'utf-8');

    const { threadId } = await startAgentForTask({
      task,
      prompt,
      workingDir: task.worktreePath || projectDir,
      projectDir,
      onComplete,
    });

    // Update task with agent
    task.assignedAgent = threadId;
    task.status = 'planning';
    await taskPersistence.saveTask(task);

    await fs.appendFile(logsPath, `[Agent Started] Thread ID: ${threadId}\n`, 'utf-8');

    return NextResponse.json({
      success: true,
      message: 'Answers submitted, plan generation started',
      threadId,
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
 * Build plan generation prompt with user answers
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildPlanGenerationPrompt(task: any, answers: Record<string, any>): string {
  const basePrompt = `You are an AI planning assistant. Your task is to create a detailed implementation plan based on the task requirements and the user's answers to your questions.

Title: ${task.title}
Description: ${task.description}

CLI Tool: ${task.cliTool || 'Not specified'}
${task.cliConfig ? `CLI Config: ${JSON.stringify(task.cliConfig, null, 2)}` : ''}

# User Answers to Planning Questions

${task.planningData?.questions
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .map((q: any) => {
    const answer = answers[q.id];
    return `Q${q.order ?? '?'}: ${q.question}\nA: ${answer?.selectedOption || 'Not answered'}${answer?.additionalText ? `\nAdditional notes: ${answer.additionalText}` : ''}`;
  })
  .join('\n\n')}

# PLANNING PHASE: Generate Implementation Plan

Based on the user's answers above, create a comprehensive implementation plan that addresses their specific requirements and preferences.

Your plan should include:
1. **Overview**: Brief summary incorporating user preferences
2. **Technical Approach**: Architecture decisions based on user's choices
3. **Implementation Steps**: Numbered, actionable steps
4. **Files to Modify**: List of files to create/change
5. **Testing Strategy**: How to verify it works (considering user's testing preference)
6. **Potential Issues**: Known gotchas specific to chosen approach
7. **Success Criteria**: Clear completion criteria

Format your plan in Markdown with clear headings and bullet points.

Return your plan in the following JSON format:
{
  "plan": "# Implementation Plan\\n\\n## Overview\\n...full markdown plan here..."
}

IMPORTANT: Return ONLY valid JSON. Do not include any markdown formatting around the JSON.`;

  return basePrompt;
}
