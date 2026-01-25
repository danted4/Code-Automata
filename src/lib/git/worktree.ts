/**
 * Git Worktree Manager
 *
 * Handles creation, deletion, and management of isolated git worktrees
 * for task execution. Each task gets its own worktree with a unique branch.
 *
 * Architecture:
 * - One worktree per task at `.code-auto/worktrees/{task-id}/`
 * - One branch per task: `code-auto/{task-id}`
 * - All subtasks for a task work in the same worktree
 * - Multiple concurrent worktrees support parallel task execution
 */

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

export interface WorktreeInfo {
  path: string;
  branchName: string;
  taskId: string;
  mainRepo: string;
  mainBranch: string;
}

export interface WorktreeStatus {
  exists: boolean;
  path?: string;
  branchName?: string;
  hasChanges?: boolean;
  isDirty?: boolean; // Has uncommitted changes
  error?: string;
}

export class WorktreeManager {
  private mainRepoPath: string | null = null;
  private mainBranch: string | null = null;

  /**
   * Get the root directory of the main git repository
   * Walks up directory tree until it finds .git directory
   */
  async getMainRepoPath(): Promise<string> {
    if (this.mainRepoPath) return this.mainRepoPath;

    try {
      const result = execSync('git rev-parse --show-toplevel', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      this.mainRepoPath = result;
      return result;
    } catch (error) {
      throw new Error(
        'Failed to detect git repository root. Ensure you are in a git repository.'
      );
    }
  }

  /**
   * Auto-detect the main branch (main or master)
   */
  async getMainBranch(): Promise<string> {
    if (this.mainBranch) return this.mainBranch;

    try {
      // Try to get the default branch
      const result = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
        .trim()
        .split('/')
        .pop();

      if (result) {
        this.mainBranch = result;
        return result;
      }

      // Fallback: Check for main or master locally
      const localBranches = execSync('git branch -l', {
        encoding: 'utf-8',
      });

      if (localBranches.includes('* main') || localBranches.includes('main')) {
        this.mainBranch = 'main';
        return 'main';
      }

      if (localBranches.includes('* master') || localBranches.includes('master')) {
        this.mainBranch = 'master';
        return 'master';
      }

      // Ultimate fallback
      this.mainBranch = 'main';
      return 'main';
    } catch (error) {
      // Fallback to 'main' if detection fails
      this.mainBranch = 'main';
      return 'main';
    }
  }

  /**
   * Get the worktree base directory path
   */
  async getWorktreeBasePath(): Promise<string> {
    const mainRepo = await this.getMainRepoPath();
    return path.join(mainRepo, '.code-auto', 'worktrees');
  }

  /**
   * Get the path for a specific task's worktree
   */
  async getWorktreePath(taskId: string): Promise<string> {
    const basePath = await this.getWorktreeBasePath();
    return path.join(basePath, taskId);
  }

  /**
   * Create a new worktree for a task
   * - Creates branch: code-auto/{task-id}
   * - Creates worktree at: .code-auto/worktrees/{task-id}/
   * - Branch auto-commits changes after each subtask
   *
   * @returns WorktreeInfo with paths and branch info
   */
  async createWorktree(taskId: string): Promise<WorktreeInfo> {
    try {
      const mainRepo = await this.getMainRepoPath();
      const mainBranch = await this.getMainBranch();
      const worktreePath = await this.getWorktreePath(taskId);
      const branchName = `code-auto/${taskId}`;

      // Ensure base directory exists
      const basePath = await this.getWorktreeBasePath();
      if (!fs.existsSync(basePath)) {
        fs.mkdirSync(basePath, { recursive: true });
      }

      // Check if worktree already exists
      const status = await this.getWorktreeStatus(taskId);
      if (status.exists) {
        throw new Error(
          `Worktree already exists at ${worktreePath}. Delete it first or use a different task ID.`
        );
      }

      // Create worktree with new branch
      // Branch will be created from the main branch
      execSync(`git worktree add "${worktreePath}" -b "${branchName}"`, {
        cwd: mainRepo,
        stdio: 'pipe',
      });

      // Verify creation
      if (!fs.existsSync(worktreePath)) {
        throw new Error(`Failed to create worktree at ${worktreePath}`);
      }

      console.log(`✓ Worktree created: ${worktreePath}`);
      console.log(`✓ Branch: ${branchName}`);

      return {
        path: worktreePath,
        branchName,
        taskId,
        mainRepo,
        mainBranch,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create worktree for task ${taskId}: ${message}`);
    }
  }

  /**
   * Get status of a worktree
   */
  async getWorktreeStatus(taskId: string): Promise<WorktreeStatus> {
    try {
      const worktreePath = await this.getWorktreePath(taskId);

      if (!fs.existsSync(worktreePath)) {
        return { exists: false };
      }

      // Check for git changes
      try {
        const status = execSync('git status --porcelain', {
          cwd: worktreePath,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();

        const hasChanges = status.length > 0;

        // Get current branch
        const branchName = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: worktreePath,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();

        return {
          exists: true,
          path: worktreePath,
          branchName,
          hasChanges,
          isDirty: hasChanges,
        };
      } catch {
        // Path exists but not a valid git repo
        return {
          exists: true,
          path: worktreePath,
          error: 'Directory exists but is not a valid git worktree',
        };
      }
    } catch (error) {
      return {
        exists: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Delete a worktree
   * - Optionally force delete if it has uncommitted changes
   * - Will not delete if MR/PR exists (manual cleanup required)
   *
   * @param taskId - Task ID whose worktree to delete
   * @param force - Force delete even with uncommitted changes
   */
  async deleteWorktree(taskId: string, force: boolean = false): Promise<void> {
    try {
      const mainRepo = await this.getMainRepoPath();
      const worktreePath = await this.getWorktreePath(taskId);

      const status = await this.getWorktreeStatus(taskId);
      if (!status.exists) {
        console.log(`Worktree does not exist: ${worktreePath}`);
        return;
      }

      // Check for uncommitted changes
      if (status.isDirty && !force) {
        throw new Error(
          `Worktree has uncommitted changes. Use force=true to delete anyway, or commit changes first.`
        );
      }

      // Delete worktree
      const forceFlag = force ? '--force' : '';
      execSync(`git worktree remove "${worktreePath}" ${forceFlag}`, {
        cwd: mainRepo,
        stdio: 'pipe',
      });

      // Clean up directory if still exists
      if (fs.existsSync(worktreePath)) {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }

      console.log(`✓ Worktree deleted: ${worktreePath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to delete worktree for task ${taskId}: ${message}`);
    }
  }

  /**
   * List all active worktrees
   */
  async listWorktrees(): Promise<WorktreeInfo[]> {
    try {
      const mainRepo = await this.getMainRepoPath();
      const output = execSync('git worktree list --porcelain', {
        cwd: mainRepo,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const mainBranch = await this.getMainBranch();
      const worktrees: WorktreeInfo[] = [];

      for (const line of output.split('\n')) {
        if (!line.trim()) continue;

        const parts = line.split(' ');
        const worktreePath = parts[0];

        // Extract task ID from path (expects .code-auto/worktrees/{task-id})
        if (worktreePath.includes('.code-auto/worktrees/')) {
          const taskId = path.basename(worktreePath);
          const branchName = `code-auto/${taskId}`;

          worktrees.push({
            path: worktreePath,
            branchName,
            taskId,
            mainRepo,
            mainBranch,
          });
        }
      }

      return worktrees;
    } catch (error) {
      throw new Error(`Failed to list worktrees: ${error}`);
    }
  }

  /**
   * Clean up all worktrees (useful for testing/reset)
   * Be careful: this will delete ALL worktrees in .code-auto/worktrees/
   */
  async cleanupAllWorktrees(force: boolean = false): Promise<void> {
    try {
      const worktrees = await this.listWorktrees();

      for (const wt of worktrees) {
        await this.deleteWorktree(wt.taskId, force);
      }

      console.log(`✓ Cleaned up ${worktrees.length} worktree(s)`);
    } catch (error) {
      throw new Error(`Failed to cleanup worktrees: ${error}`);
    }
  }

  /**
   * Verify git is available and the current directory is in a git repo
   */
  async verifyGitAvailable(): Promise<boolean> {
    try {
      execSync('git --version', {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      await this.getMainRepoPath(); // Also check we're in a repo
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Singleton instance for application-wide use
 */
let instance: WorktreeManager | null = null;

export function getWorktreeManager(): WorktreeManager {
  if (!instance) {
    instance = new WorktreeManager();
  }
  return instance;
}
