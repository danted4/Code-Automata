/**
 * Local dev reset route
 *
 * Deletes Code-Auto local state under `.code-auto/`:
 * - tasks JSON
 * - implementation_plan.json
 * - git worktrees under `.code-auto/worktrees/*` (via git worktree remove)
 *
 * This is intended for local development only.
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getWorktreeManager } from '@/lib/git/worktree';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({} as any));
    const force = !!body?.force;

    const manager = getWorktreeManager();
    const gitAvailable = await manager.verifyGitAvailable();

    let worktreesCleaned = 0;
    if (gitAvailable) {
      const before = await manager.listWorktrees().catch(() => []);
      await manager.cleanupAllWorktrees(force);
      worktreesCleaned = before.length;
    }

    const base = path.join(process.cwd(), '.code-auto');
    await fs.rm(path.join(base, 'tasks'), { recursive: true, force: true });
    await fs.rm(path.join(base, 'implementation_plan.json'), { force: true });
    await fs.rm(path.join(base, 'thread-index.json'), { force: true });

    return NextResponse.json({
      success: true,
      worktreesCleaned,
      message: 'Local Code-Auto state reset complete',
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

