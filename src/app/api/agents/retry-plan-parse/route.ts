/**
 * Retry Plan Parse API Route
 *
 * For tasks blocked during plan generation (JSON parse failure), reads the last
 * agent output from planning logs, re-parses it with extractAndValidateJSON,
 * and resumes the task if successful.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTaskPersistence } from '@/lib/tasks/persistence';
import { getProjectDir } from '@/lib/project-dir';
import { extractAndValidateJSON } from '@/lib/validation/subtask-validator';
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

    let logsContent: string;
    try {
      logsContent = await fs.readFile(logsPath, 'utf-8');
    } catch {
      return NextResponse.json(
        { error: 'Planning logs not found. Cannot retry parse.' },
        { status: 404 }
      );
    }

    const lastOutputIdx = logsContent.lastIndexOf(OUTPUT_MARKER);
    if (lastOutputIdx === -1) {
      return NextResponse.json(
        { error: 'No [Output] block found in planning logs.' },
        { status: 400 }
      );
    }

    const rawOutput = logsContent.slice(lastOutputIdx + OUTPUT_MARKER.length).trim();

    const { data: parsedOutput, error: jsonError } = extractAndValidateJSON(rawOutput);
    if (jsonError || !parsedOutput) {
      return NextResponse.json(
        { error: `Parse failed: ${jsonError || 'No JSON found'}` },
        { status: 400 }
      );
    }

    const planContent = (parsedOutput as { plan?: string }).plan;
    if (!planContent) {
      return NextResponse.json({ error: 'Parsed JSON has no "plan" field.' }, { status: 400 });
    }

    task.planContent = planContent;
    task.planningStatus = 'plan_ready';
    task.status = 'pending';
    task.assignedAgent = undefined;
    task.updatedAt = Date.now();
    await taskPersistence.saveTask(task);

    await fs.appendFile(
      logsPath,
      `\n[Retry Parse] ${new Date().toISOString()} - Successfully extracted plan from logs. Task resumed.\n`,
      'utf-8'
    );

    return NextResponse.json({
      success: true,
      message: 'Plan extracted successfully. Task resumed.',
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
