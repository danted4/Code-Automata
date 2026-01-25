/**
 * Seed Tasks API Route
 *
 * Creates sample tasks for testing the Kanban board
 */

import { NextResponse } from 'next/server';
import { taskPersistence } from '@/lib/tasks/persistence';
import { Task, WORKFLOW_PHASES } from '@/lib/tasks/schema';

export async function POST() {
  try {
    const sampleTasks: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>[] = [
      {
        title: 'Implement user authentication',
        description: 'Add JWT-based authentication with OAuth support for GitHub and Google',
        phase: 'planning',
        status: 'pending',
        subtasks: [],
        cliTool: 'amp',
        cliConfig: { mode: 'rush' },
        requiresHumanReview: false,
        planApproved: false,
        planningStatus: 'not_started',
        metadata: { estimatedComplexity: 'high' },
      },
      {
        title: 'Design database schema',
        description: 'Create PostgreSQL schema for users, sessions, and task data',
        phase: 'planning',
        status: 'pending',
        subtasks: [],
        cliTool: 'amp',
        cliConfig: { mode: 'rush' },
        requiresHumanReview: false,
        planApproved: false,
        planningStatus: 'not_started',
        metadata: { estimatedComplexity: 'medium' },
      },
      {
        title: 'Build REST API endpoints',
        description: 'Implement CRUD operations for task management',
        phase: 'in_progress',
        status: 'in_progress',
        subtasks: [
          { id: '1', content: 'Create endpoint', label: 'Create endpoint', type: 'dev', status: 'completed', completedAt: Date.now() },
          { id: '2', content: 'Update endpoint', label: 'Update endpoint', type: 'dev', status: 'in_progress' },
          { id: '3', content: 'List endpoint', label: 'List endpoint', type: 'dev', status: 'pending' },
          { id: '4', content: 'Verify endpoints work correctly', label: 'Verify endpoints', type: 'qa', status: 'pending' },
        ],
        cliTool: 'amp',
        cliConfig: { mode: 'rush' },
        requiresHumanReview: false,
        metadata: { estimatedComplexity: 'medium' },
      },
      {
        title: 'Add error handling middleware',
        description: 'Global error handling and logging for API',
        phase: 'ai_review',
        status: 'completed',
        subtasks: [],
        cliTool: 'amp',
        cliConfig: { mode: 'rush' },
        requiresHumanReview: false,
        metadata: { estimatedComplexity: 'low' },
      },
      {
        title: 'Implement real-time notifications',
        description: 'Add WebSocket support for live updates',
        phase: 'human_review',
        status: 'pending',
        subtasks: [
          { id: '1', content: 'WebSocket server', label: 'WebSocket server', type: 'qa', status: 'completed', completedAt: Date.now() },
          { id: '2', content: 'Client integration', label: 'Client integration', type: 'qa', status: 'completed', completedAt: Date.now() },
        ],
        cliTool: 'amp',
        cliConfig: { mode: 'rush' },
        requiresHumanReview: false,
        metadata: { estimatedComplexity: 'high' },
      },
      {
        title: 'Set up CI/CD pipeline',
        description: 'Configure GitHub Actions for automated testing and deployment',
        phase: 'done',
        status: 'completed',
        subtasks: [
          { id: '1', content: 'GitHub Actions workflow', label: 'GitHub Actions workflow', type: 'dev', status: 'completed', completedAt: Date.now() },
          { id: '2', content: 'Deploy to production', label: 'Deploy to production', type: 'dev', status: 'completed', completedAt: Date.now() },
        ],
        cliTool: 'amp',
        cliConfig: { mode: 'rush' },
        requiresHumanReview: false,
        metadata: { estimatedComplexity: 'low' },
      },
    ];

    const createdTasks: Task[] = [];

    for (const taskData of sampleTasks) {
      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const task: Task = {
        ...taskData,
        id: taskId,
        branchName: `code-auto/${taskId}`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await taskPersistence.saveTask(task);
      createdTasks.push(task);

      // Small delay to ensure unique IDs
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    return NextResponse.json({
      success: true,
      message: `Created ${createdTasks.length} sample tasks`,
      tasks: createdTasks,
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
