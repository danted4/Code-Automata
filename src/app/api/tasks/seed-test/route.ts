/**
 * Seed Test Tasks API Route
 *
 * Creates sample tasks for E2E testing (marked with isTestData flag)
 */

import { NextResponse } from 'next/server';
import { taskPersistence } from '@/lib/tasks/persistence';
import { Task } from '@/lib/tasks/schema';

export async function POST() {
  try {
    const sampleTasks: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>[] = [
      {
        title: 'Implement user authentication',
        description: 'Add JWT-based authentication with OAuth support for GitHub and Google',
        phase: 'planning',
        status: 'pending',
        subtasks: [],
        metadata: { estimatedComplexity: 'high', isTestData: true },
      },
      {
        title: 'Design database schema',
        description: 'Create PostgreSQL schema for users, sessions, and task data',
        phase: 'planning',
        status: 'pending',
        subtasks: [],
        metadata: { estimatedComplexity: 'medium', isTestData: true },
      },
      {
        title: 'Build REST API endpoints',
        description: 'Implement CRUD operations for task management',
        phase: 'in_progress',
        status: 'in_progress',
        subtasks: [
          { id: '1', content: 'Create endpoint', label: 'Create endpoint', status: 'completed', completedAt: Date.now() },
          { id: '2', content: 'Update endpoint', label: 'Update endpoint', status: 'in_progress' },
          { id: '3', content: 'List endpoint', label: 'List endpoint', status: 'pending' },
        ],
        metadata: { estimatedComplexity: 'medium', isTestData: true },
      },
      {
        title: 'Add error handling middleware',
        description: 'Global error handling and logging for API',
        phase: 'ai_review',
        status: 'completed',
        subtasks: [],
        metadata: { estimatedComplexity: 'low', isTestData: true },
      },
      {
        title: 'Implement real-time notifications',
        description: 'Add WebSocket support for live updates',
        phase: 'human_review',
        status: 'pending',
        subtasks: [
          { id: '1', content: 'WebSocket server', label: 'WebSocket server', status: 'completed', completedAt: Date.now() },
          { id: '2', content: 'Client integration', label: 'Client integration', status: 'completed', completedAt: Date.now() },
        ],
        metadata: { estimatedComplexity: 'high', isTestData: true },
      },
      {
        title: 'Set up CI/CD pipeline',
        description: 'Configure GitHub Actions for automated testing and deployment',
        phase: 'done',
        status: 'completed',
        subtasks: [
          { id: '1', content: 'GitHub Actions workflow', label: 'GitHub Actions workflow', status: 'completed', completedAt: Date.now() },
          { id: '2', content: 'Deploy to production', label: 'Deploy to production', status: 'completed', completedAt: Date.now() },
        ],
        metadata: { estimatedComplexity: 'low', isTestData: true },
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
      message: `Created ${createdTasks.length} test tasks`,
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
