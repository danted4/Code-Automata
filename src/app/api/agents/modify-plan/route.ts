/**
 * Modify Plan API Route
 *
 * Handles plan modifications via inline editing or AI feedback regeneration
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTaskPersistence } from '@/lib/tasks/persistence';
import { startAgentForTask } from '@/lib/agents/registry';
import { getProjectDir } from '@/lib/project-dir';
import { cleanPlanningArtifactsFromWorktree } from '@/lib/worktree/cleanup';
import fs from 'fs/promises';
import path from 'path';

export async function POST(req: NextRequest) {
  try {
    const projectDir = await getProjectDir(req);
    const taskPersistence = getTaskPersistence(projectDir);

    const { taskId, method, newPlan, feedback } = await req.json();

    if (!taskId || !method) {
      return NextResponse.json({ error: 'taskId and method required' }, { status: 400 });
    }

    // Load task
    const task = await taskPersistence.loadTask(taskId);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const logsPath = task.planningLogsPath
      ? path.isAbsolute(task.planningLogsPath)
        ? task.planningLogsPath
        : path.join(projectDir, task.planningLogsPath)
      : path.join(projectDir, '.code-auto', 'tasks', taskId, 'planning-logs.txt');

    if (method === 'inline') {
      // Direct inline edit - just save the new plan
      if (!newPlan) {
        return NextResponse.json({ error: 'newPlan required for inline method' }, { status: 400 });
      }

      await fs.appendFile(
        logsPath,
        `\n${'='.repeat(80)}\n` +
          `[Plan Modified - Inline Edit] ${new Date().toISOString()}\n` +
          `${'='.repeat(80)}\n\n`,
        'utf-8'
      );

      task.planContent = newPlan;
      task.planningStatus = 'plan_ready';
      await taskPersistence.saveTask(task);

      return NextResponse.json({
        success: true,
        message: 'Plan updated successfully',
      });
    } else if (method === 'feedback') {
      // AI feedback regeneration
      if (!feedback) {
        return NextResponse.json(
          { error: 'feedback required for feedback method' },
          { status: 400 }
        );
      }

      await fs.appendFile(
        logsPath,
        `\n${'='.repeat(80)}\n` +
          `[Plan Modification Requested] ${new Date().toISOString()}\n` +
          `Feedback: ${feedback}\n` +
          `${'='.repeat(80)}\n\n`,
        'utf-8'
      );

      // Build regeneration prompt
      const prompt = `You are an AI planning assistant. You previously created an implementation plan, but the user has requested modifications.

**Original Task:**
Title: ${task.title}
Description: ${task.description}

**Current Plan:**
${task.planContent}

**User Feedback:**
${feedback}

Please regenerate the plan incorporating the user's feedback while maintaining the overall structure and quality.

Return your updated plan in the following JSON format:
{
  "plan": "# Implementation Plan\\n\\n## Overview\\n...full updated markdown plan here..."
}

CRITICAL: The system ONLY captures your text output. You MUST output the raw JSON as plain text in your message - writing to a file does NOT work. No markdown fences, no extra text.`;

      // Create completion handler
      const onComplete = async (result: { success: boolean; output: string; error?: string }) => {
        await fs.appendFile(
          logsPath,
          `\n[Plan Regeneration Completed] Success: ${result.success}\n`,
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

        try {
          const jsonMatch = result.output.match(/\{[\s\S]*\}/);
          if (!jsonMatch) {
            throw new Error('No JSON found in output');
          }

          const parsedOutput = JSON.parse(jsonMatch[0]);
          await fs.appendFile(logsPath, `[Parsed JSON successfully]\n`, 'utf-8');

          const currentTask = await taskPersistence.loadTask(taskId);
          if (!currentTask) return;

          if (parsedOutput.plan) {
            await fs.appendFile(logsPath, `[Updated Plan Saved]\n`, 'utf-8');

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

          // Fallback: agent may have written plan to implementation-plan.json
          const workingDir = task.worktreePath || projectDir;
          for (const basename of ['implementation-plan.json', 'implementation_plan.json']) {
            try {
              const filePath = path.join(workingDir, basename);
              const fileContent = await fs.readFile(filePath, 'utf-8');
              const fileParsed = JSON.parse(fileContent) as { plan?: string };
              if (fileParsed?.plan && typeof fileParsed.plan === 'string') {
                await fs.appendFile(
                  logsPath,
                  `[Fallback] Found plan in ${basename}, using it.\n`,
                  'utf-8'
                );
                const currentTask = await taskPersistence.loadTask(taskId);
                if (currentTask) {
                  currentTask.planContent = fileParsed.plan;
                  currentTask.planningStatus = 'plan_ready';
                  currentTask.status = 'pending';
                  currentTask.assignedAgent = undefined;
                  await taskPersistence.saveTask(currentTask);
                  await cleanPlanningArtifactsFromWorktree(task.worktreePath || projectDir);
                  await fs.appendFile(logsPath, `[Task Updated Successfully]\n`, 'utf-8');
                }
                return;
              }
            } catch {
              /* continue */
            }
          }

          const currentTask = await taskPersistence.loadTask(taskId);
          if (currentTask) {
            currentTask.status = 'blocked';
            currentTask.assignedAgent = undefined;
            await taskPersistence.saveTask(currentTask);
          }
        }
      };

      // Start regeneration agent
      await fs.appendFile(logsPath, `[Starting Plan Regeneration Agent]\n`, 'utf-8');

      const { threadId } = await startAgentForTask({
        task,
        prompt,
        workingDir: task.worktreePath || projectDir,
        projectDir,
        onComplete,
      });

      task.assignedAgent = threadId;
      task.status = 'planning';
      task.planningStatus = 'generating_plan';
      await taskPersistence.saveTask(task);

      await fs.appendFile(logsPath, `[Agent Started] Thread ID: ${threadId}\n`, 'utf-8');

      return NextResponse.json({
        success: true,
        message: 'Plan regeneration started',
        threadId,
      });
    } else {
      return NextResponse.json(
        { error: 'Invalid method. Must be "inline" or "feedback"' },
        { status: 400 }
      );
    }
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
