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
        phase: 'discovery',
        status: 'in_progress',
        subtasks: [],
        metadata: { estimatedComplexity: 'high' },
      },
      {
        title: 'Design database schema',
        description: 'Create PostgreSQL schema for users, sessions, and task data',
        phase: 'requirements',
        status: 'pending',
        subtasks: [],
        metadata: { estimatedComplexity: 'medium' },
      },
      {
        title: 'Set up CI/CD pipeline',
        description: 'Configure GitHub Actions for automated testing and deployment',
        phase: 'context',
        status: 'pending',
        subtasks: [],
        metadata: { estimatedComplexity: 'low' },
      },
      {
        title: 'Build REST API endpoints',
        description: 'Implement CRUD operations for task management',
        phase: 'spec',
        status: 'completed',
        subtasks: [
          { id: '1', content: 'Create endpoint', status: 'completed', completedAt: Date.now() },
          { id: '2', content: 'Update endpoint', status: 'completed', completedAt: Date.now() },
          { id: '3', content: 'List endpoint', status: 'completed', completedAt: Date.now() },
        ],
        metadata: { estimatedComplexity: 'medium' },
      },
      {
        title: 'Implement real-time notifications',
        description: 'Add WebSocket support for live updates',
        phase: 'planning',
        status: 'blocked',
        subtasks: [],
        metadata: { estimatedComplexity: 'high' },
      },
      {
        title: 'Write integration tests',
        description: 'Add end-to-end tests for critical user flows',
        phase: 'validate',
        status: 'in_progress',
        subtasks: [
          { id: '1', content: 'Auth flow tests', status: 'completed', completedAt: Date.now() },
          { id: '2', content: 'Task CRUD tests', status: 'in_progress' },
          { id: '3', content: 'Agent tests', status: 'pending' },
        ],
        metadata: { estimatedComplexity: 'medium' },
      },
    ];

    const createdTasks: Task[] = [];

    for (const taskData of sampleTasks) {
      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const task: Task = {
        ...taskData,
        id: taskId,
        branchName: `auto-claude/${taskId}`,
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
