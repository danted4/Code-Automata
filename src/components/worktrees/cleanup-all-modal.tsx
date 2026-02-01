'use client';

/**
 * Cleanup All Modal
 *
 * Single confirmation for removing all worktrees. Shows count N and
 * "Remove all N worktree(s)? This cannot be undone." Confirm calls
 * cleanup-all API; Cancel closes the modal.
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
import { Loader2, AlertTriangle } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';

interface CleanupAllModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Number of worktrees that will be removed */
  count: number;
  /** Called after successful cleanup so parent can refresh the list */
  onCleanedUp?: () => void;
}

export function CleanupAllModal({
  open,
  onOpenChange,
  count,
  onCleanedUp,
}: CleanupAllModalProps) {
  const [isCleaning, setIsCleaning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetState = useCallback(() => {
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
    if (count < 1) return;
    setIsCleaning(true);
    setError(null);
    try {
      const res = await apiFetch('/api/git/worktree', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cleanup-all' }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Cleanup failed (${res.status})`);
      }
      resetState();
      onOpenChange(false);
      onCleanedUp?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cleanup failed');
    } finally {
      setIsCleaning(false);
    }
  }, [count, onOpenChange, onCleanedUp, resetState]);

  return (
    <Dialog open={open} onOpenChange={isCleaning ? undefined : handleOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" style={{ color: 'var(--color-destructive)' }} />
            Remove All Worktrees
          </DialogTitle>
          <DialogDescription>
            Remove all {count} worktree{count === 1 ? '' : 's'}? This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="py-4">
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
                Removing...
              </>
            ) : (
              'Confirm'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
