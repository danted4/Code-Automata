'use client';

/**
 * Delete Worktree Modal
 *
 * Confirmation for single worktree delete: shows path and task ID.
 * If worktree is dirty, shows warning and "Force delete (discard changes)" option.
 * If orphan, shows optional "Also delete branch." checkbox.
 * Confirm calls delete API with force and alsoDeleteBranch as chosen.
 */

import { useState, useCallback } from 'react';
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
import { Loader2, AlertTriangle } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import type { WorktreeItem } from './worktree-card';

interface DeleteWorktreeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  worktree: WorktreeItem | null;
  /** Called after successful delete so parent can refresh the list */
  onDeleted?: () => void;
}

export function DeleteWorktreeModal({
  open,
  onOpenChange,
  worktree,
  onDeleted,
}: DeleteWorktreeModalProps) {
  const [forceDelete, setForceDelete] = useState(false);
  const [alsoDeleteBranch, setAlsoDeleteBranch] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDirty = worktree?.isDirty ?? false;
  const isOrphan = worktree?.isOrphan ?? false;

  const canConfirm = !isDirty || forceDelete;

  const resetState = useCallback(() => {
    setForceDelete(false);
    setAlsoDeleteBranch(false);
    setError(null);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) resetState();
      onOpenChange(next);
    },
    [onOpenChange, resetState]
  );

  const handleConfirm = useCallback(async () => {
    if (!worktree || !canConfirm) return;
    setIsDeleting(true);
    setError(null);
    try {
      const res = await apiFetch('/api/git/worktree', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'delete',
          taskId: worktree.taskId,
          force: forceDelete,
          alsoDeleteBranch: isOrphan ? alsoDeleteBranch : undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Delete failed (${res.status})`);
      }
      resetState();
      onOpenChange(false);
      onDeleted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete worktree');
    } finally {
      setIsDeleting(false);
    }
  }, [
    worktree,
    canConfirm,
    forceDelete,
    isOrphan,
    alsoDeleteBranch,
    onOpenChange,
    onDeleted,
    resetState,
  ]);

  if (!worktree) return null;

  return (
    <Dialog open={open} onOpenChange={isDeleting ? undefined : handleOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" style={{ color: 'var(--color-destructive)' }} />
            Delete Worktree
          </DialogTitle>
          <DialogDescription>
            This will remove the worktree from the repository. Uncommitted changes may be lost if
            you force delete.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4 py-4">
          <div className="space-y-3">
            <div>
              <div
                className="text-sm font-medium mb-1"
                style={{ color: 'var(--color-text-primary)' }}
              >
                Task ID
              </div>
              <div
                className="text-sm font-mono px-2 py-1 rounded"
                style={{
                  backgroundColor: 'var(--color-surface-hover)',
                  color: 'var(--color-text-secondary)',
                }}
              >
                {worktree.taskId}
              </div>
            </div>
            <div>
              <div
                className="text-sm font-medium mb-1"
                style={{ color: 'var(--color-text-primary)' }}
              >
                Path
              </div>
              <div
                className="text-sm font-mono px-2 py-1 rounded truncate"
                style={{
                  backgroundColor: 'var(--color-surface-hover)',
                  color: 'var(--color-text-secondary)',
                }}
                title={worktree.path}
              >
                {worktree.path}
              </div>
            </div>
          </div>

          {isDirty && (
            <div
              className="rounded-md border p-3 space-y-3"
              style={{
                borderColor: 'var(--color-destructive)',
                backgroundColor: 'var(--color-surface-hover)',
              }}
            >
              <div className="flex items-start gap-2">
                <AlertTriangle
                  className="w-4 h-4 mt-0.5 flex-shrink-0"
                  style={{ color: 'var(--color-destructive)' }}
                />
                <div className="space-y-1">
                  <div className="text-sm font-medium" style={{ color: 'var(--color-destructive)' }}>
                    Uncommitted changes
                  </div>
                  <div className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                    This worktree has uncommitted changes. To delete it you must discard them.
                  </div>
                </div>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="force-delete"
                  checked={forceDelete}
                  onCheckedChange={(checked) => setForceDelete(checked === true)}
                />
                <Label
                  htmlFor="force-delete"
                  className="text-sm cursor-pointer"
                  style={{ color: 'var(--color-text-primary)' }}
                >
                  Force delete (discard changes)
                </Label>
              </div>
            </div>
          )}

          {isOrphan && (
            <div className="flex items-center space-x-2">
              <Checkbox
                id="also-delete-branch"
                checked={alsoDeleteBranch}
                onCheckedChange={(checked) => setAlsoDeleteBranch(checked === true)}
              />
              <Label
                htmlFor="also-delete-branch"
                className="text-sm cursor-pointer"
                style={{ color: 'var(--color-text-primary)' }}
              >
                Also delete branch
              </Label>
            </div>
          )}

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
            disabled={isDeleting}
            style={{
              background: 'var(--color-surface-hover)',
              color: 'var(--color-text-primary)',
              borderColor: 'var(--color-border)',
            }}
            onMouseEnter={(e) => {
              if (!isDeleting) e.currentTarget.style.background = 'var(--color-background)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--color-surface-hover)';
            }}
          >
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={isDeleting || !canConfirm}
            className="font-medium"
            style={{
              backgroundColor: 'var(--color-destructive)',
              color: 'var(--color-surface)',
            }}
            onMouseEnter={(e) => {
              if (!isDeleting && canConfirm) e.currentTarget.style.opacity = '0.9';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.opacity = '1';
            }}
          >
            {isDeleting ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Deleting...
              </>
            ) : (
              'Delete Worktree'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
