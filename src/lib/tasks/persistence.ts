/**
 * Task Persistence Layer
 *
 * File-based storage for tasks using JSON files
 */

import fs from 'fs/promises';
import path from 'path';
import { Task, WORKFLOW_PHASES } from './schema';

const TASKS_DIR = path.join(process.cwd(), '.auto-claude', 'tasks');
const IMPLEMENTATION_PLAN = path.join(
  process.cwd(),
  '.auto-claude',
  'implementation_plan.json'
);

export class TaskPersistence {
  /**
   * Ensure tasks directory exists
   */
  private async ensureDir(): Promise<void> {
    await fs.mkdir(TASKS_DIR, { recursive: true });
  }

  /**
   * Save a task to disk
   */
  async saveTask(task: Task): Promise<void> {
    await this.ensureDir();
    const filePath = path.join(TASKS_DIR, `${task.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(task, null, 2));

    // Also update implementation_plan.json for Auto-Claude compatibility
    await this.updateImplementationPlan();
  }

  /**
   * Load a task from disk
   */
  async loadTask(taskId: string): Promise<Task | null> {
    const filePath = path.join(TASKS_DIR, `${taskId}.json`);
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data) as Task;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null; // File doesn't exist
      }
      throw error;
    }
  }

  /**
   * List all tasks
   */
  async listTasks(): Promise<Task[]> {
    await this.ensureDir();
    try {
      const files = await fs.readdir(TASKS_DIR);
      const taskFiles = files.filter((f) => f.endsWith('.json'));

      const tasks = await Promise.all(
        taskFiles.map(async (file) => {
          const taskId = file.replace('.json', '');
          return this.loadTask(taskId);
        })
      );

      // Filter out nulls and sort by creation date
      return tasks
        .filter((t): t is Task => t !== null)
        .sort((a, b) => b.createdAt - a.createdAt);
    } catch (error) {
      return [];
    }
  }

  /**
   * Delete a task
   */
  async deleteTask(taskId: string): Promise<void> {
    const filePath = path.join(TASKS_DIR, `${taskId}.json`);
    try {
      await fs.unlink(filePath);
      await this.updateImplementationPlan();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /**
   * Update task status
   */
  async updateTaskStatus(taskId: string, status: Task['status']): Promise<void> {
    const task = await this.loadTask(taskId);
    if (task) {
      task.status = status;
      task.updatedAt = Date.now();
      await this.saveTask(task);
    }
  }

  /**
   * Update task phase
   */
  async updateTaskPhase(taskId: string, phase: Task['phase']): Promise<void> {
    const task = await this.loadTask(taskId);
    if (task) {
      task.phase = phase;
      task.updatedAt = Date.now();
      await this.saveTask(task);
    }
  }

  /**
   * Update implementation_plan.json (Auto-Claude compatibility)
   */
  private async updateImplementationPlan(): Promise<void> {
    const tasks = await this.listTasks();

    const plan = {
      version: '1.0',
      updated: new Date().toISOString(),
      totalTasks: tasks.length,
      phases: WORKFLOW_PHASES.map((phase) => ({
        name: phase,
        tasks: tasks.filter((t) => t.phase === phase).map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          subtasks: t.subtasks.length,
          assignedAgent: t.assignedAgent,
        })),
      })),
    };

    try {
      await fs.writeFile(IMPLEMENTATION_PLAN, JSON.stringify(plan, null, 2));
    } catch (error) {
      console.error('Failed to update implementation plan:', error);
    }
  }
}

// Export singleton instance
export const taskPersistence = new TaskPersistence();
