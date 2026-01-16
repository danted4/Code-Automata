/**
 * Start Planning Agent API Route
 *
 * Starts an AI agent to plan a task
 * - If human review required: generates questions first
 * - If no human review: generates plan directly
 */

import { NextRequest, NextResponse } from 'next/server';
import { agentManager } from '@/lib/agents/singleton';
import { taskPersistence } from '@/lib/tasks/persistence';
import fs from 'fs/promises';
import path from 'path';

const MAX_RETRIES = 10;

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

    // Check if task already has an agent assigned
    if (task.assignedAgent) {
      const existingSession = agentManager.getAgentStatus(task.assignedAgent);
      if (existingSession && existingSession.status === 'running') {
        return NextResponse.json(
          { error: 'Task already has an agent running' },
          { status: 409 }
        );
      }
    }

    // Ensure planning logs directory exists
    const logsPath = task.planningLogsPath || `.code-auto/tasks/${taskId}/planning-logs.txt`;
    const logsDir = path.dirname(logsPath);
    await fs.mkdir(logsDir, { recursive: true });

    // Initialize log file
    await fs.writeFile(
      logsPath,
      `Planning started for task: ${task.title}\n` +
      `Task ID: ${taskId}\n` +
      `Requires Human Review: ${task.requiresHumanReview}\n` +
      `Started at: ${new Date().toISOString()}\n` +
      `${'='.repeat(80)}\n\n`,
      'utf-8'
    );

    // Build planning prompt
    const prompt = buildPlanningPrompt(task);

    // Create completion handler
    const onComplete = async (result: { success: boolean; output: string; error?: string }) => {
      await appendToLog(logsPath, `\n[Agent Completed] Success: ${result.success}\n`);

      if (!result.success) {
        await appendToLog(logsPath, `[Error] ${result.error}\n`);

        // Update task to blocked status
        const currentTask = await taskPersistence.loadTask(taskId);
        if (currentTask) {
          currentTask.status = 'blocked';
          currentTask.assignedAgent = undefined;
          await taskPersistence.saveTask(currentTask);
        }
        return;
      }

      await appendToLog(logsPath, `[Output]\n${result.output}\n`);

      // Parse JSON output
      try {
        const jsonMatch = result.output.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error('No JSON found in output');
        }

        const parsedOutput = JSON.parse(jsonMatch[0]);
        await appendToLog(logsPath, `[Parsed JSON successfully]\n`);

        // Load current task
        const currentTask = await taskPersistence.loadTask(taskId);
        if (!currentTask) return;

        // Update task based on output type
        if (parsedOutput.questions) {
          // Questions generated
          await appendToLog(logsPath, `[Questions Generated] ${parsedOutput.questions.length} questions\n`);

          currentTask.planningData = {
            questions: parsedOutput.questions,
            generatedAt: Date.now(),
            status: 'pending',
          };
          currentTask.planningStatus = 'waiting_for_answers';
          currentTask.status = 'pending'; // Change from 'planning' to 'pending'
          currentTask.assignedAgent = undefined; // Clear agent

          await taskPersistence.saveTask(currentTask);
          await appendToLog(logsPath, `[Task Updated Successfully]\n`);
        } else if (parsedOutput.plan) {
          // Plan generated directly
          await appendToLog(logsPath, `[Plan Generated]\n`);

          currentTask.planContent = parsedOutput.plan;
          currentTask.planningStatus = 'plan_ready';
          currentTask.status = 'pending';
          currentTask.assignedAgent = undefined;

          // If no human review required, auto-approve and start development
          if (!currentTask.requiresHumanReview) {
            await appendToLog(logsPath, `[Auto-approving plan (no human review required)]\n`);

            currentTask.planApproved = true;
            currentTask.planningStatus = 'plan_approved';

            // IMPORTANT: Save task BEFORE starting development so planApproved flag is persisted
            await taskPersistence.saveTask(currentTask);
            await appendToLog(logsPath, `[Task saved with planApproved = true]\n`);

            // Start development immediately (generate subtasks and execute)
            await appendToLog(logsPath, `[Starting Development Automatically - Generating Subtasks]\n`);

            try {
              const response = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/agents/start-development`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskId }),
              });

              if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to start development');
              }

              const result = await response.json();
              await appendToLog(logsPath, `[Development Started] Thread ID: ${result.threadId}\n`);

              // Task already saved, and start-development will handle further updates
              // No need to save again
            } catch (error) {
              await appendToLog(
                logsPath,
                `[Error Starting Development] ${error instanceof Error ? error.message : 'Unknown error'}\n`
              );
              currentTask.status = 'blocked';
              await taskPersistence.saveTask(currentTask);
              await appendToLog(logsPath, `[Task saved with blocked status]\n`);
            }
          } else {
            // Human review required - save task with plan ready
            await taskPersistence.saveTask(currentTask);
            await appendToLog(logsPath, `[Task Updated Successfully]\n`);
          }
        }
      } catch (parseError) {
        await appendToLog(
          logsPath,
          `[Parse Error] Failed to parse JSON: ${parseError instanceof Error ? parseError.message : 'Unknown error'}\n`
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

    // Start agent with retry logic
    let threadId: string | null = null;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await appendToLog(logsPath, `\n[Attempt ${attempt}/${MAX_RETRIES}] Starting planning agent...\n`);

        threadId = await agentManager.startAgent(taskId, prompt, {
          workingDir: task.worktreePath || process.cwd(),
          onComplete,
        });

        await appendToLog(logsPath, `[Success] Agent started with thread ID: ${threadId}\n`);
        break; // Success, exit retry loop
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown error');
        await appendToLog(
          logsPath,
          `[Attempt ${attempt}/${MAX_RETRIES}] Error: ${lastError.message}\n`
        );

        if (attempt < MAX_RETRIES) {
          await appendToLog(logsPath, `[Retry] Waiting 2 seconds before retry...\n`);
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds before retry
        }
      }
    }

    // If all retries failed
    if (!threadId) {
      await appendToLog(
        logsPath,
        `\n[FAILED] All ${MAX_RETRIES} attempts failed. Last error: ${lastError?.message}\n`
      );

      // Update task to blocked status
      task.status = 'blocked';
      task.planningStatus = 'not_started';
      await taskPersistence.saveTask(task);

      return NextResponse.json(
        { error: `Failed after ${MAX_RETRIES} attempts: ${lastError?.message}` },
        { status: 500 }
      );
    }

    // Update task with assigned agent and planning status
    task.assignedAgent = threadId;
    task.status = 'planning';
    task.planningStatus = task.requiresHumanReview
      ? 'generating_questions'
      : 'generating_plan';
    task.planningLogsPath = logsPath;
    await taskPersistence.saveTask(task);

    return NextResponse.json({
      success: true,
      threadId,
      planningStatus: task.planningStatus,
      message: 'Planning agent started successfully',
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
 * Build the planning prompt based on task requirements
 */
function buildPlanningPrompt(task: any): string {
  const basePrompt = `You are an AI planning assistant. Your task is to help plan the implementation of the following task:

Title: ${task.title}
Description: ${task.description}

CLI Tool: ${task.cliTool || 'Not specified'}
${task.cliConfig ? `CLI Config: ${JSON.stringify(task.cliConfig, null, 2)}` : ''}

`;

  if (task.requiresHumanReview) {
    // Generate questions for human to answer
    return basePrompt + `# PLANNING PHASE 1: Question Generation

Your goal is to generate clarifying questions to better understand the requirements before creating a plan.

Generate 5-20 multiple-choice questions that will help clarify:
1. Technical approach and architecture decisions
2. User preferences and priorities
3. Edge cases and error handling requirements
4. Performance and scalability considerations
5. Testing and validation requirements

For each question, provide:
- A clear, specific question
- 3-5 multiple choice options
- Mark if the question is required or optional

Return your questions in the following JSON format:
{
  "questions": [
    {
      "id": "q1",
      "question": "Which authentication method should we use?",
      "options": ["JWT tokens", "Session-based", "OAuth 2.0", "Custom solution"],
      "required": true,
      "order": 1
    },
    {
      "id": "q2",
      "question": "How should we handle errors?",
      "options": ["Silent logging", "User notifications", "Retry with backoff", "Combination approach"],
      "required": true,
      "order": 2
    }
  ]
}

IMPORTANT: Return ONLY valid JSON. Do not include any markdown formatting or additional text.`;
  } else {
    // Generate plan directly
    return basePrompt + `# PLANNING PHASE: Direct Plan Generation

Your goal is to create a comprehensive implementation plan for this task.

Create a detailed plan that includes:
1. **Overview**: Brief summary of what needs to be done
2. **Technical Approach**: Architecture and technology decisions
3. **Implementation Steps**: Numbered, actionable steps
4. **Files to Modify**: List of files that need to be created or changed
5. **Testing Strategy**: How to verify the implementation works
6. **Potential Issues**: Known gotchas and how to handle them
7. **Success Criteria**: How to know when the task is complete

Format your plan in Markdown with clear headings and bullet points.

Return your plan in the following JSON format:
{
  "plan": "# Implementation Plan\\n\\n## Overview\\n...full markdown plan here..."
}

IMPORTANT: Return ONLY valid JSON. Do not include any markdown formatting around the JSON.`;
  }
}

/**
 * Append text to log file
 */
async function appendToLog(logPath: string, text: string): Promise<void> {
  try {
    await fs.appendFile(logPath, text, 'utf-8');
  } catch (error) {
    console.error('Failed to write to log file:', error);
  }
}
