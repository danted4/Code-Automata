'use client';

/**
 * Cleanup Modal
 *
 * Single modal with toggles to select which worktrees to remove:
 * 1. Orphan worktrees (default ON) - worktrees whose tasks no longer exist
 * 2. Clean worktrees (default OFF) - worktrees with tasks, no uncommitted changes
 * 3. Dirty worktrees (default OFF) - worktrees with tasks, uncommitted changes
 *
 * Also includes branch deletion options.
 */

import { useState, useCallback, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogBody,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Loader2, AlertTriangle } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import type { WorktreeItem } from './worktree-card';

interface CleanupModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** All worktrees for the project */
  worktrees: WorktreeItem[];
  /** Called after successful cleanup with removed count */
  onCleanedUp?: (removedCount: number) => void;
}

function filterMatching(
  worktrees: WorktreeItem[],
  includeOrphans: boolean,
  includeClean: boolean,
  includeDirty: boolean
): WorktreeItem[] {
  return worktrees.filter((w) => {
    if (includeOrphans && w.isOrphan) return true;
    if (w.isOrphan) return false;
    if (includeClean && !w.isDirty) return true;
    if (includeDirty && w.isDirty) return true;
    return false;
  });
}

export function CleanupModal({ open, onOpenChange, worktrees, onCleanedUp }: CleanupModalProps) {
  const [isCleaning, setIsCleaning] = useState(false);
  const [deletedCount, setDeletedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [includeOrphans, setIncludeOrphans] = useState(true);
  const [includeClean, setIncludeClean] = useState(false);
  const [includeDirty, setIncludeDirty] = useState(false);
  const [alsoDeleteBranch, setAlsoDeleteBranch] = useState(true);
  const [alsoDeleteFromRemote, setAlsoDeleteFromRemote] = useState(false);

  const toRemove = useMemo(
    () => filterMatching(worktrees, includeOrphans, includeClean, includeDirty),
    [worktrees, includeOrphans, includeClean, includeDirty]
  );
  const count = toRemove.length;

  const resetState = useCallback(() => {
    setError(null);
    setDeletedCount(0);
    setIncludeOrphans(true);
    setIncludeClean(false);
    setIncludeDirty(false);
    setAlsoDeleteBranch(true);
    setAlsoDeleteFromRemote(false);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) resetState();
      onOpenChange(next);
    },
    [onOpenChange, resetState]
  );

  const handleConfirm = useCallback(async () => {
    if (count < 1) return;
    setIsCleaning(true);
    setError(null);
    setDeletedCount(0);
    let removed = 0;
    try {
      for (const wt of toRemove) {
        const res = await apiFetch('/api/git/worktree', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'delete',
            taskId: wt.taskId,
            force: true,
            alsoDeleteBranch,
            alsoDeleteFromRemote: alsoDeleteBranch ? alsoDeleteFromRemote : false,
            path: wt.path,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error ?? `Failed to delete worktree ${wt.taskId}`);
        }
        removed += 1;
        setDeletedCount(removed);
      }
      resetState();
      onOpenChange(false);
      onCleanedUp?.(removed);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cleanup failed');
      setDeletedCount(removed);
    } finally {
      setIsCleaning(false);
    }
  }, [
    count,
    toRemove,
    alsoDeleteBranch,
    alsoDeleteFromRemote,
    onOpenChange,
    onCleanedUp,
    resetState,
  ]);

  const orphanCount = worktrees.filter((w) => w.isOrphan).length;
  const cleanCount = worktrees.filter((w) => !w.isOrphan && !w.isDirty).length;
  const dirtyCount = worktrees.filter((w) => !w.isOrphan && w.isDirty).length;

  return (
    <Dialog open={open} onOpenChange={isCleaning ? undefined : handleOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" style={{ color: 'var(--color-destructive)' }} />
            Cleanup Worktrees
          </DialogTitle>
          <DialogDescription>
            Select which worktrees to remove. {count} worktree{count === 1 ? '' : 's'} will be
            removed. This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4 py-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label
                  htmlFor="toggle-orphans"
                  className="text-sm font-medium cursor-pointer"
                  style={{ color: 'var(--color-text-primary)' }}
                >
                  Orphan worktrees
                </Label>
                <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                  Worktrees whose tasks no longer exist ({orphanCount})
                </p>
              </div>
              <Switch
                id="toggle-orphans"
                checked={includeOrphans}
                onCheckedChange={setIncludeOrphans}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label
                  htmlFor="toggle-clean"
                  className="text-sm font-medium cursor-pointer"
                  style={{ color: 'var(--color-text-primary)' }}
                >
                  Clean worktrees
                </Label>
                <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                  Worktrees with tasks, no uncommitted changes ({cleanCount})
                </p>
              </div>
              <Switch id="toggle-clean" checked={includeClean} onCheckedChange={setIncludeClean} />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label
                  htmlFor="toggle-dirty"
                  className="text-sm font-medium cursor-pointer"
                  style={{ color: 'var(--color-text-primary)' }}
                >
                  Dirty worktrees
                </Label>
                <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                  Worktrees with tasks, uncommitted changes ({dirtyCount})
                </p>
              </div>
              <Switch id="toggle-dirty" checked={includeDirty} onCheckedChange={setIncludeDirty} />
            </div>
          </div>

          <div className="border-t pt-4" style={{ borderColor: 'var(--color-border)' }}>
            <div className="space-y-2">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="cleanup-delete-branch"
                  checked={alsoDeleteBranch}
                  onCheckedChange={(checked) => {
                    setAlsoDeleteBranch(checked === true);
                    if (checked !== true) setAlsoDeleteFromRemote(false);
                  }}
                />
                <Label
                  htmlFor="cleanup-delete-branch"
                  className="text-sm cursor-pointer"
                  style={{ color: 'var(--color-text-primary)' }}
                >
                  Also delete branches (local)
                </Label>
              </div>
              {alsoDeleteBranch && (
                <div className="flex items-center space-x-2 pl-6">
                  <Checkbox
                    id="cleanup-delete-remote"
                    checked={alsoDeleteFromRemote}
                    onCheckedChange={(checked) => setAlsoDeleteFromRemote(checked === true)}
                  />
                  <Label
                    htmlFor="cleanup-delete-remote"
                    className="text-sm cursor-pointer"
                    style={{ color: 'var(--color-text-primary)' }}
                  >
                    Also delete from remote (origin)
                  </Label>
                </div>
              )}
            </div>
          </div>

          {error && (
            <div
              className="rounded-md border p-2 text-sm"
              style={{
                borderColor: 'var(--color-destructive)',
                color: 'var(--color-destructive)',
                backgroundColor: 'var(--color-surface-hover)',
              }}
            >
              {error}
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isCleaning}
            style={{
              background: 'var(--color-surface-hover)',
              color: 'var(--color-text-primary)',
              borderColor: 'var(--color-border)',
            }}
            onMouseEnter={(e) => {
              if (!isCleaning) e.currentTarget.style.background = 'var(--color-background)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--color-surface-hover)';
            }}
          >
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={isCleaning || count < 1}
            className="font-medium"
            style={{
              backgroundColor: 'var(--color-destructive)',
              color: 'var(--color-surface)',
            }}
            onMouseEnter={(e) => {
              if (!isCleaning && count >= 1) e.currentTarget.style.opacity = '0.9';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.opacity = '1';
            }}
          >
            {isCleaning ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Removed {deletedCount}/{count}
              </>
            ) : (
              `Remove ${count} worktree${count === 1 ? '' : 's'}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
