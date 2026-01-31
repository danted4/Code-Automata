/**
 * Clean planning artifacts from worktree.
 *
 * Agents may write implementation-plan.json, planning-questions.json, etc.
 * to the worktree during planning. These should not appear in the final
 * output before human review. Call this at every transition past planning.
 */

import fs from 'fs/promises';
import path from 'path';

const PLANNING_ARTIFACTS = [
  'implementation-plan.json',
  'implementation_plan.json',
  'planning-questions.json',
  'planning_questions.json',
];

/**
 * Remove planning artifact files from the worktree if they exist.
 * Safe to call multiple times; ignores missing files.
 *
 * @param worktreePath - Absolute path to the worktree (e.g. .code-auto/worktrees/task-xxx)
 */
export async function cleanPlanningArtifactsFromWorktree(worktreePath: string): Promise<void> {
  if (!worktreePath || typeof worktreePath !== 'string') return;

  const resolved = path.resolve(worktreePath.trim());
  if (!resolved) return;

  for (const basename of PLANNING_ARTIFACTS) {
    try {
      const filePath = path.join(resolved, basename);
      await fs.unlink(filePath);
    } catch (err) {
      // Ignore ENOENT (file not found) - that's expected
      const code =
        err && typeof err === 'object' && 'code' in err ? (err as NodeJS.ErrnoException).code : '';
      if (code !== 'ENOENT') {
        console.warn(`[cleanPlanningArtifacts] Failed to remove ${basename}:`, err);
      }
    }
  }
}
