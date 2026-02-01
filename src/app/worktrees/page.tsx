'use client';

/**
 * Worktrees Page
 *
 * Lists git worktrees for the current project: disk usage summary,
 * "Cleanup all" action, and WorktreeCard list. Delete opens DeleteWorktreeModal;
 * cleanup-all opens CleanupAllModal. Uses apiFetch with X-Project-Path.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { WorktreeCard, type WorktreeItem } from '@/components/worktrees/worktree-card';
import { DeleteWorktreeModal } from '@/components/worktrees/delete-worktree-modal';
import { CleanupAllModal } from '@/components/worktrees/cleanup-all-modal';
import { Button } from '@/components/ui/button';
import { Loader2, AlertCircle, HardDrive, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

interface WorktreesListResponse {
  worktrees: WorktreeItem[];
  count: number;
  totalDiskUsageBytes: number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export default function WorktreesPage() {
  const [data, setData] = useState<WorktreesListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [worktreeToDelete, setWorktreeToDelete] = useState<WorktreeItem | null>(null);
  const [cleanupModalOpen, setCleanupModalOpen] = useState(false);

  const fetchWorktrees = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/git/worktree?action=list');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const bodyError = typeof body?.error === 'string' ? body.error : null;
        if (res.status === 503) {
          setError(bodyError ?? 'Git is not available');
        } else if (res.status >= 500) {
          setError(bodyError ?? 'Server error');
        } else {
          setError(bodyError ?? `Request failed (${res.status})`);
        }
        setData(null);
        return;
      }
      const json: WorktreesListResponse = await res.json();
      setData(json);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load worktrees';
      setError(message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWorktrees();
  }, [fetchWorktrees]);

  const handleRetry = useCallback(() => {
    setError(null);
    fetchWorktrees();
  }, [fetchWorktrees]);

  const handleDeleteClick = useCallback((taskId: string) => {
    const worktree = data?.worktrees.find((w) => w.taskId === taskId) ?? null;
    setWorktreeToDelete(worktree);
    setDeleteModalOpen(true);
  }, [data?.worktrees]);

  const handleDeleted = useCallback(() => {
    toast.success('Worktree deleted');
    fetchWorktrees();
  }, [fetchWorktrees]);

  const handleCleanedUp = useCallback(() => {
    toast.success('All worktrees removed');
    fetchWorktrees();
  }, [fetchWorktrees]);

  if (loading) {
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center gap-4 p-6"
        style={{ background: 'var(--color-background)', color: 'var(--color-text-primary)' }}
      >
        <Loader2 className="w-10 h-10 animate-spin" style={{ color: 'var(--color-primary)' }} />
        <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          Loading worktrees…
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div
        data-testid="worktrees-error-state"
        className="min-h-screen flex flex-col items-center justify-center gap-6 p-6"
        style={{ background: 'var(--color-background)', color: 'var(--color-text-primary)' }}
      >
        <div
          className="rounded-lg border p-6 max-w-md w-full text-center space-y-4"
          style={{
            background: 'var(--color-surface)',
            borderColor: 'var(--color-border)',
          }}
        >
          <AlertCircle
            className="w-12 h-12 mx-auto"
            style={{ color: 'var(--color-destructive)' }}
          />
          <h2 className="text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>
            Something went wrong
          </h2>
          <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            {error}
          </p>
          <Button
            onClick={handleRetry}
            style={{
              backgroundColor: 'var(--color-primary)',
              color: 'var(--color-primary-text)',
            }}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const count = data?.count ?? 0;

  if (count === 0) {
    return (
      <div
        data-testid="worktrees-empty-state"
        className="min-h-screen flex flex-col items-center justify-center gap-6 p-6"
        style={{ background: 'var(--color-background)', color: 'var(--color-text-primary)' }}
      >
        <div
          className="rounded-lg border p-8 max-w-md w-full text-center space-y-4"
          style={{
            background: 'var(--color-surface)',
            borderColor: 'var(--color-border)',
          }}
        >
          <HardDrive
            className="w-12 h-12 mx-auto"
            style={{ color: 'var(--color-text-muted)' }}
          />
          <h2 className="text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>
            No worktrees
          </h2>
          <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            There are no git worktrees for this project yet. Worktrees are created when you start
            working on a task.
          </p>
        </div>
      </div>
    );
  }

  const worktrees = data!.worktrees;
  const totalBytes = data!.totalDiskUsageBytes;

  return (
    <div
      className="min-h-screen p-6"
      style={{ background: 'var(--color-background)', color: 'var(--color-text-primary)' }}
    >
      <div className="max-w-4xl mx-auto space-y-6">
        <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <h1 className="text-2xl font-bold" style={{ color: 'var(--color-text-primary)' }}>
            Worktrees
          </h1>
          <div className="flex items-center gap-4">
            <div
              className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm"
              style={{
                background: 'var(--color-surface)',
                border: '1px solid var(--color-border)',
                color: 'var(--color-text-secondary)',
              }}
            >
              <HardDrive className="w-4 h-4" />
              <span>Total: {formatBytes(totalBytes)}</span>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              style={{
                borderColor: 'var(--color-destructive)',
                color: 'var(--color-destructive)',
              }}
              onClick={() => setCleanupModalOpen(true)}
            >
              <Trash2 className="w-4 h-4" />
              Cleanup all
            </Button>
          </div>
        </header>

        <ul data-testid="worktrees-list" className="grid gap-4 sm:grid-cols-2">
          {worktrees.map((worktree) => (
            <li key={worktree.taskId}>
              <WorktreeCard worktree={worktree} onDelete={handleDeleteClick} />
            </li>
          ))}
        </ul>
      </div>

      <DeleteWorktreeModal
        open={deleteModalOpen}
        onOpenChange={(open) => {
          setDeleteModalOpen(open);
          if (!open) setWorktreeToDelete(null);
        }}
        worktree={worktreeToDelete}
        onDeleted={handleDeleted}
      />

      <CleanupAllModal
        open={cleanupModalOpen}
        onOpenChange={setCleanupModalOpen}
        count={count}
        onCleanedUp={handleCleanedUp}
      />
    </div>
  );
}
