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

/**
 * Recursively compute directory size in bytes. Skips symlinks and ignores errors (e.g. permission).
 */
function getDirectorySizeBytes(dirPath: string): number {
  let total = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          total += getDirectorySizeBytes(fullPath);
        } else if (stat.isFile()) {
          total += stat.size;
        }
      } catch {
        // Skip inaccessible entries
      }
    }
  } catch {
    // Directory not readable
  }
  return total;
}

export interface WorktreeInfo {
  path: string;
  branchName: string;
  taskId: string;
  mainRepo: string;
  mainBranch: string;
  /** True if the worktree has uncommitted changes (from getWorktreeStatus). */
  isDirty?: boolean;
}

export interface WorktreeDiskUsage {
  totalBytes: number;
  perWorktree: Record<string, number>;
}

export interface WorktreeStatus {
  exists: boolean;
  path?: string;
  branchName?: string;
  hasChanges?: boolean;
  isDirty?: boolean; // Has uncommitted changes
  error?: string;
}

/**
 * Enriched worktree list item with status and disk usage.
 * Use listWorktreesEnriched() to get this shape; listWorktrees() returns WorktreeInfo[] for compatibility.
 */
export interface WorktreeListItem {
  taskId: string;
  path: string;
  branchName: string;
  isDirty: boolean;
  diskUsageBytes: number;
}

export class WorktreeManager {
  private readonly projectDir: string;
  private mainRepoPath: string | null = null;
  private mainBranch: string | null = null;

  constructor(projectDir: string = process.cwd()) {
    this.projectDir = projectDir;
  }

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
        cwd: this.projectDir,
      }).trim();

      this.mainRepoPath = result;
      return result;
    } catch (_error) {
      throw new Error('Failed to detect git repository root. Ensure you are in a git repository.');
    }
  }

  /**
   * Auto-detect the main branch (main or master)
   */
  async getMainBranch(): Promise<string> {
    if (this.mainBranch) return this.mainBranch;

    try {
      const mainRepo = await this.getMainRepoPath();

      // Try to get the default branch
      const result = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: mainRepo,
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
        cwd: mainRepo,
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
    } catch (_error) {
      // Fallback to 'main' if detection fails
      this.mainBranch = 'main';
      return 'main';
    }
  }

  /**
   * Get the worktree base directory path (absolute).
   */
  async getWorktreeBasePath(): Promise<string> {
    const mainRepo = await this.getMainRepoPath();
    return path.resolve(mainRepo, '.code-auto', 'worktrees');
  }

  /**
   * Get the absolute path for a specific task's worktree.
   */
  async getWorktreePath(taskId: string): Promise<string> {
    const basePath = await this.getWorktreeBasePath();
    return path.resolve(basePath, taskId);
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
        path: path.resolve(worktreePath),
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
          path: path.resolve(worktreePath),
          branchName,
          hasChanges,
          isDirty: hasChanges,
        };
      } catch {
        // Path exists but not a valid git repo
        return {
          exists: true,
          path: path.resolve(worktreePath),
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
   * - When alsoDeleteBranch is true, runs `git branch -D code-auto/{taskId}` in the main repo after removal
   * - When alsoDeleteFromRemote is true, runs `git push origin --delete code-auto/{taskId}` after local branch removal
   *
   * @param taskId - Task ID whose worktree to delete
   * @param force - Force delete even with uncommitted changes
   * @param alsoDeleteBranch - If true, delete the local branch code-auto/{taskId} after removing the worktree
   * @param alsoDeleteFromRemote - If true, delete the branch from origin (remote) as well
   * @param worktreePathOverride - When provided, use this path instead of getWorktreePath(taskId). Use the actual path from git worktree list to avoid projectDir mismatch.
   */
  async deleteWorktree(
    taskId: string,
    force: boolean = false,
    alsoDeleteBranch?: boolean,
    alsoDeleteFromRemote?: boolean,
    worktreePathOverride?: string
  ): Promise<void> {
    try {
      const mainRepo = await this.getMainRepoPath();
      const worktreePath = worktreePathOverride ?? (await this.getWorktreePath(taskId));

      // When using override (actual path from git), skip getWorktreeStatus - it may use wrong path
      const status = worktreePathOverride
        ? { exists: fs.existsSync(worktreePath), isDirty: false }
        : await this.getWorktreeStatus(taskId);

      // For prunable worktrees (override + dir gone): git still has the reference.
      // Don't return early - try git worktree remove anyway; it cleans up stale refs.
      if (!status.exists && !worktreePathOverride) {
        // No override and path doesn't exist - nothing to do
        console.log(`Worktree does not exist: ${worktreePath}`);
        return;
      }

      // Check for uncommitted changes (only when we have full status and dir exists)
      if (!worktreePathOverride && status.exists && status.isDirty && !force) {
        throw new Error(
          `Worktree has uncommitted changes. Use force=true to delete anyway, or commit changes first.`
        );
      }

      // Delete worktree
      const forceFlag = force ? '--force' : '';
      try {
        execSync(`git worktree remove "${worktreePath}" ${forceFlag}`.trim(), {
          cwd: mainRepo,
          stdio: 'pipe',
        });
      } catch (removeError) {
        // Fallback for prunable/broken worktrees (e.g. "gitdir file points to non-existent")
        // Remove directory manually and prune stale references
        try {
          if (fs.existsSync(worktreePath)) {
            fs.rmSync(worktreePath, { recursive: true, force: true });
          }
          execSync('git worktree prune', { cwd: mainRepo, stdio: 'pipe' });
          console.log(`✓ Worktree removed (fallback prune): ${worktreePath}`);
        } catch (fallbackError) {
          const origMsg = removeError instanceof Error ? removeError.message : String(removeError);
          const fallbackMsg =
            fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          throw new Error(
            `Failed to delete worktree for task ${taskId}: ${origMsg}. Fallback also failed: ${fallbackMsg}`
          );
        }
      }

      // Clean up directory if still exists (e.g. remove didn't delete it)
      if (fs.existsSync(worktreePath)) {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }

      console.log(`✓ Worktree deleted: ${worktreePath}`);

      const branchName = `code-auto/${taskId}`;
      if (alsoDeleteBranch) {
        try {
          execSync(`git branch -D "${branchName}"`, {
            cwd: mainRepo,
            stdio: 'pipe',
          });
          console.log(`✓ Branch deleted (local): ${branchName}`);
        } catch (branchError) {
          // Branch may already be deleted or not exist; log but don't fail
          console.warn(`Could not delete local branch ${branchName}:`, branchError);
        }
      }
      if (alsoDeleteFromRemote) {
        try {
          execSync(`git push origin --delete "${branchName}"`, {
            cwd: mainRepo,
            stdio: 'pipe',
          });
          console.log(`✓ Branch deleted (remote): ${branchName}`);
        } catch (remoteError) {
          const msg = remoteError instanceof Error ? remoteError.message : String(remoteError);
          // "remote ref does not exist" is expected when branch was never pushed - silently ignore
          if (!msg.includes('remote ref does not exist') && !msg.includes('unable to delete')) {
            console.warn(`Could not delete remote branch ${branchName}:`, remoteError);
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to delete worktree for task ${taskId}: ${message}`);
    }
  }

  /**
   * List all active worktrees (paths are normalized to absolute).
   * Each entry includes isDirty from getWorktreeStatus.
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

        // Porcelain format: "worktree /path/to/worktree" (key space value)
        const spaceIdx = line.indexOf(' ');
        if (spaceIdx === -1) continue;
        const key = line.slice(0, spaceIdx);
        const value = line.slice(spaceIdx + 1).trim();
        if (key !== 'worktree') continue;

        const rawPath = value;

        // Extract task ID from path (expects .code-auto/worktrees/{task-id})
        const pathNorm = rawPath.replace(/\\/g, '/');
        if (pathNorm.includes('.code-auto/worktrees/')) {
          const taskId = path.basename(path.normalize(rawPath));
          const branchName = `code-auto/${taskId}`;
          const absolutePath = path.isAbsolute(rawPath)
            ? path.normalize(rawPath)
            : path.resolve(mainRepo, rawPath);

          const status = await this.getWorktreeStatus(taskId);
          worktrees.push({
            path: absolutePath,
            branchName,
            taskId,
            mainRepo,
            mainBranch,
            isDirty: status.isDirty,
          });
        }
      }

      return worktrees;
    } catch (error) {
      throw new Error(`Failed to list worktrees: ${error}`);
    }
  }

  /**
   * List all worktrees with enriched fields: isDirty (from getWorktreeStatus) and diskUsageBytes (from getDiskUsage).
   * Use this when you need status and size per worktree; listWorktrees() remains for callers that need WorktreeInfo (e.g. mainRepo, mainBranch).
   */
  async listWorktreesEnriched(): Promise<WorktreeListItem[]> {
    const [worktrees, usage] = await Promise.all([this.listWorktrees(), this.getDiskUsage()]);
    return worktrees.map((wt) => ({
      taskId: wt.taskId,
      path: wt.path,
      branchName: wt.branchName,
      isDirty: wt.isDirty ?? false,
      diskUsageBytes: usage.perWorktree[wt.taskId] ?? 0,
    }));
  }

  /**
   * Compute total and per-worktree disk usage for .code-auto/worktrees.
   */
  async getDiskUsage(): Promise<WorktreeDiskUsage> {
    const basePath = await this.getWorktreeBasePath();
    const perWorktree: Record<string, number> = {};
    let totalBytes = 0;

    if (!fs.existsSync(basePath) || !fs.statSync(basePath).isDirectory()) {
      return { totalBytes: 0, perWorktree };
    }

    const entries = fs.readdirSync(basePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const taskId = entry.name;
      const dirPath = path.resolve(basePath, taskId);
      const size = getDirectorySizeBytes(dirPath);
      perWorktree[taskId] = size;
      totalBytes += size;
    }

    return { totalBytes, perWorktree };
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

const worktreeCache = new Map<string, WorktreeManager>();

/**
 * Get WorktreeManager instance for the given project directory.
 * Caches instances by projectDir for efficiency.
 * Falls back to process.cwd() when projectDir is not provided.
 */
export function getWorktreeManager(projectDir: string = process.cwd()): WorktreeManager {
  let instance = worktreeCache.get(projectDir);
  if (!instance) {
    instance = new WorktreeManager(projectDir);
    worktreeCache.set(projectDir, instance);
  }
  return instance;
}
