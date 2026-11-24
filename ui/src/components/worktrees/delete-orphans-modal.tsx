/**
 * Confirms deleting one or more orphan worktrees (their task files are gone). The server removes
 * each worktree, uncommitted changes and all, and its local branch.
 */

import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { WorktreeEntry } from '@/lib/api/types/WorktreeEntry';

interface DeleteOrphansModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The orphans to delete: one for a card's Delete, all of them for a cleanup. */
  worktrees: WorktreeEntry[];
  /** Does the deleting; the dialog closes when it settles. */
  onConfirm: () => Promise<void>;
}

export function DeleteOrphansModal({
  open,
  onOpenChange,
  worktrees,
  onConfirm,
}: DeleteOrphansModalProps) {
  const [deleting, setDeleting] = useState(false);
  const count = worktrees.length;
  const single = count === 1;

  const confirm = async () => {
    setDeleting(true);
    try {
      await onConfirm();
    } finally {
      setDeleting(false);
      onOpenChange(false);
    }
  };

  const dirty = worktrees.some((w) => w.isDirty);

  return (
    <Dialog open={open} onOpenChange={deleting ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-[520px]" data-testid="worktree-delete-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" style={{ color: 'var(--color-destructive)' }} />
            {single ? 'Delete orphan worktree' : `Delete ${count} orphan worktrees`}
          </DialogTitle>
          <DialogDescription>
            {single ? 'Its task no longer exists.' : 'Their tasks no longer exist.'} This removes
            the worktree folder and its local branch. It cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <ul className="space-y-1 max-h-48 overflow-y-auto">
            {worktrees.map((w) => (
              <li
                key={w.taskId}
                className="text-xs font-mono px-2 py-1 rounded truncate"
                style={{
                  backgroundColor: 'var(--color-surface-hover)',
                  color: 'var(--color-text-secondary)',
                }}
                title={w.path}
              >
                {w.branchName ?? w.taskId}
                <span style={{ color: 'var(--color-text-muted)' }}> · {w.path}</span>
              </li>
            ))}
          </ul>
          {dirty && (
            <p className="text-sm" style={{ color: 'var(--color-destructive)' }}>
              Uncommitted changes in {single ? 'this worktree' : 'some of these worktrees'} will be
              lost.
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button
            data-testid="worktree-delete-confirm"
            onClick={confirm}
            disabled={deleting || count === 0}
            style={{
              background: 'var(--color-destructive)',
              color: 'var(--color-destructive-text)',
            }}
          >
            {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
