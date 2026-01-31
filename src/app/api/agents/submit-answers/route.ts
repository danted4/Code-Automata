/**
 * Submit Planning Answers API Route
 *
 * Receives answers to planning questions and triggers plan generation.
 * When JSON extraction fails, runs a fix agent to repair the output (up to MAX_PARSE_RETRIES).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTaskPersistence } from '@/lib/tasks/persistence';
import { getProjectDir } from '@/lib/project-dir';
import { startPlanGeneration } from '@/lib/agents/plan-generation';
import fs from 'fs/promises';
import path from 'path';

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

    const { threadId } = await startPlanGeneration({
      taskId,
      task,
      answers,
      projectDir,
      logsPath,
      taskPersistence,
    });

    task.assignedAgent = threadId;
    task.status = 'planning';
    await taskPersistence.saveTask(task);

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
