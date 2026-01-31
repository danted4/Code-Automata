/**
 * Retry Plan Parse API Route (Resume)
 *
 * For tasks blocked during plan generation:
 * 1. Try to parse plan from logs or implementation-plan.json (instant recovery)
 * 2. If both fail, re-invoke the plan generation agent with saved answers
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTaskPersistence } from '@/lib/tasks/persistence';
import { getProjectDir } from '@/lib/project-dir';
import { extractAndValidateJSON } from '@/lib/validation/subtask-validator';
import { startPlanGeneration } from '@/lib/agents/plan-generation';
import { cleanPlanningArtifactsFromWorktree } from '@/lib/worktree/cleanup';
import fs from 'fs/promises';
import path from 'path';

const OUTPUT_MARKER = '[Output]\n';

export async function POST(req: NextRequest) {
  try {
    const projectDir = await getProjectDir(req);
    const taskPersistence = getTaskPersistence(projectDir);

    const { taskId } = await req.json();

    if (!taskId) {
      return NextResponse.json({ error: 'taskId required' }, { status: 400 });
    }

    const task = await taskPersistence.loadTask(taskId);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    if (task.status !== 'blocked') {
      return NextResponse.json(
        { error: 'Task is not blocked. Only blocked tasks can be resumed.' },
        { status: 400 }
      );
    }

    if (task.planningStatus !== 'generating_plan') {
      return NextResponse.json(
        {
          error: `Task planningStatus is "${task.planningStatus}". Retry parse is only for tasks blocked during plan generation (planningStatus=generating_plan).`,
        },
        { status: 400 }
      );
    }

    const logsPath = task.planningLogsPath
      ? path.isAbsolute(task.planningLogsPath)
        ? task.planningLogsPath
        : path.join(projectDir, task.planningLogsPath)
      : path.join(projectDir, '.code-auto', 'tasks', taskId, 'planning-logs.txt');

    let planContent: string | undefined;

    // 1. Try to parse from logs
    try {
      const logsContent = await fs.readFile(logsPath, 'utf-8');
      const lastOutputIdx = logsContent.lastIndexOf(OUTPUT_MARKER);
      if (lastOutputIdx !== -1) {
        const rawOutput = logsContent.slice(lastOutputIdx + OUTPUT_MARKER.length).trim();
        const { data: parsedOutput, error: jsonError } = extractAndValidateJSON(rawOutput);
        if (!jsonError && parsedOutput) {
          planContent = (parsedOutput as { plan?: string }).plan;
        }
      }
    } catch {
      /* logs not found or unreadable */
    }

    // 2. Fallback: agent may have written plan to implementation-plan.json
    if (!planContent) {
      const workingDir = task.worktreePath || projectDir;
      for (const basename of ['implementation-plan.json', 'implementation_plan.json']) {
        try {
          const filePath = path.join(workingDir, basename);
          const fileContent = await fs.readFile(filePath, 'utf-8');
          const fileParsed = JSON.parse(fileContent) as { plan?: string };
          if (fileParsed?.plan && typeof fileParsed.plan === 'string') {
            planContent = fileParsed.plan;
            break;
          }
        } catch {
          /* continue */
        }
      }
    }

    // 3. Instant recovery: save plan and resume
    if (planContent) {
      task.planContent = planContent;
      task.planningStatus = 'plan_ready';
      task.status = 'pending';
      task.assignedAgent = undefined;
      task.updatedAt = Date.now();
      await taskPersistence.saveTask(task);
      await cleanPlanningArtifactsFromWorktree(task.worktreePath || projectDir);

      await fs.appendFile(
        logsPath,
        `\n[Retry Parse] ${new Date().toISOString()} - Successfully extracted plan. Task resumed.\n`,
        'utf-8'
      );

      return NextResponse.json({
        success: true,
        message: 'Plan extracted successfully. Task resumed.',
      });
    }

    // 4. Re-invoke plan generation agent with saved answers
    const questions = task.planningData?.questions;
    if (!questions?.length) {
      return NextResponse.json(
        { error: 'No saved answers found. Cannot re-invoke plan generation.' },
        { status: 400 }
      );
    }

    const answers: Record<string, { selectedOption?: string; additionalText?: string }> = {};
    for (const q of questions) {
      const a = q.answer as { selectedOption?: string; additionalText?: string } | undefined;
      answers[q.id] = a || { selectedOption: '', additionalText: '' };
    }

    await fs.appendFile(
      logsPath,
      `\n[Resume] ${new Date().toISOString()} - Re-invoking plan generation with saved answers.\n`,
      'utf-8'
    );

    task.planningStatus = 'generating_plan';
    task.status = 'planning';
    task.assignedAgent = undefined;
    await taskPersistence.saveTask(task);

    const { threadId } = await startPlanGeneration({
      taskId,
      task,
      answers,
      projectDir,
      logsPath,
      taskPersistence,
    });

    task.assignedAgent = threadId;
    await taskPersistence.saveTask(task);

    return NextResponse.json({
      success: true,
      message: 'Plan generation restarted with saved answers.',
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
