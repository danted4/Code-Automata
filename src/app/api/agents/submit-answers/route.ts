/**
 * Submit Planning Answers API Route
 *
 * Receives answers to planning questions and triggers plan generation
 */

import { NextRequest, NextResponse } from 'next/server';
import { taskPersistence } from '@/lib/tasks/persistence';
import { startAgentForTask } from '@/lib/agents/registry';
import fs from 'fs/promises';

export async function POST(req: NextRequest) {
  try {
    const { taskId, answers } = await req.json();

    if (!taskId || !answers) {
      return NextResponse.json(
        { error: 'taskId and answers required' },
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

    // Update task with answers
    if (task.planningData) {
      task.planningData.questions = task.planningData.questions.map(q => ({
        ...q,
        answer: answers[q.id] || { selectedOption: '', additionalText: '' },
      }));
      task.planningData.answeredAt = Date.now();
      task.planningData.status = 'completed';
    }

    task.planningStatus = 'generating_plan';
    await taskPersistence.saveTask(task);

    // Log to planning logs
    const logsPath = task.planningLogsPath || `.code-auto/tasks/${taskId}/planning-logs.txt`;
    await fs.appendFile(
      logsPath,
      `\n${'='.repeat(80)}\n` +
      `[Answers Submitted] ${new Date().toISOString()}\n` +
      `${Object.entries(answers).map(([qId, answer]: [string, any]) => {
        const question = task.planningData?.questions.find(q => q.id === qId);
        return `\nQ${question?.order || '?'}: ${question?.question || qId}\n` +
               `A: ${answer.selectedOption}\n` +
               (answer.additionalText ? `Additional: ${answer.additionalText}\n` : '');
      }).join('')}\n` +
      `${'='.repeat(80)}\n\n`,
      'utf-8'
    );

    // Build plan generation prompt with answers
    const prompt = buildPlanGenerationPrompt(task, answers);

    // Create completion handler
    const onComplete = async (result: { success: boolean; output: string; error?: string }) => {
      await fs.appendFile(logsPath, `\n[Plan Generation Completed] Success: ${result.success}\n`, 'utf-8');

      if (!result.success) {
        await fs.appendFile(logsPath, `[Error] ${result.error}\n`, 'utf-8');

        // Update task to blocked
        const currentTask = await taskPersistence.loadTask(taskId);
        if (currentTask) {
          currentTask.status = 'blocked';
          currentTask.assignedAgent = undefined;
          await taskPersistence.saveTask(currentTask);
        }
        return;
      }

      await fs.appendFile(logsPath, `[Output]\n${result.output}\n`, 'utf-8');

      // Parse JSON output
      try {
        const jsonMatch = result.output.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error('No JSON found in output');
        }

        const parsedOutput = JSON.parse(jsonMatch[0]);
        await fs.appendFile(logsPath, `[Parsed JSON successfully]\n`, 'utf-8');

        // Load current task
        const currentTask = await taskPersistence.loadTask(taskId);
        if (!currentTask) return;

        // Update task with plan
        if (parsedOutput.plan) {
          await fs.appendFile(logsPath, `[Plan Generated]\n`, 'utf-8');

          currentTask.planContent = parsedOutput.plan;
          currentTask.planningStatus = 'plan_ready';
          currentTask.status = 'pending';
          currentTask.assignedAgent = undefined;

          await taskPersistence.saveTask(currentTask);
          await fs.appendFile(logsPath, `[Task Updated Successfully]\n`, 'utf-8');
        }
      } catch (parseError) {
        await fs.appendFile(
          logsPath,
          `[Parse Error] Failed to parse JSON: ${parseError instanceof Error ? parseError.message : 'Unknown error'}\n`,
          'utf-8'
        );

        // Update task to blocked
        const currentTask = await taskPersistence.loadTask(taskId);
        if (currentTask) {
          currentTask.status = 'blocked';
          currentTask.assignedAgent = undefined;
          await taskPersistence.saveTask(currentTask);
        }
      }
    };

    // Start plan generation agent
    await fs.appendFile(logsPath, `[Starting Plan Generation]\n`, 'utf-8');

    const { threadId } = await startAgentForTask({
      task,
      prompt,
      workingDir: task.worktreePath || process.cwd(),
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
function buildPlanGenerationPrompt(task: any, answers: Record<string, any>): string {
  const basePrompt = `You are an AI planning assistant. Your task is to create a detailed implementation plan based on the task requirements and the user's answers to your questions.

Title: ${task.title}
Description: ${task.description}

CLI Tool: ${task.cliTool || 'Not specified'}
${task.cliConfig ? `CLI Config: ${JSON.stringify(task.cliConfig, null, 2)}` : ''}

# User Answers to Planning Questions

${task.planningData?.questions.map((q: any) => {
  const answer = answers[q.id];
  return `Q${q.order}: ${q.question}\nA: ${answer?.selectedOption || 'Not answered'}${answer?.additionalText ? `\nAdditional notes: ${answer.additionalText}` : ''}`;
}).join('\n\n')}

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
