/**
 * Worktrees Page: the open project's task worktrees with their disk use. Only orphans (their task
 * file is gone) can be deleted here, one at a time or all at once; a task's own worktree goes with
 * the task.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, HardDrive, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { DeleteOrphansModal } from '@/components/worktrees/delete-orphans-modal';
import { WorktreeCard } from '@/components/worktrees/worktree-card';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';
import type { DiskUsage } from '@/lib/api/types/DiskUsage';
import type { WorktreeEntry } from '@/lib/api/types/WorktreeEntry';
import { cleanupSummary, formatBytes, orphans } from '@/lib/worktree-view';
import { useProjectStore } from '@/store/project-store';

const pageStyle = { background: 'var(--color-background)', color: 'var(--color-text-primary)' };

function CenteredNotice({
  testId,
  icon,
  title,
  children,
}: {
  testId: string;
  icon: React.ReactNode;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className="h-screen flex flex-col items-center justify-center p-6"
      style={pageStyle}
    >
      <div
        className="rounded-lg border p-8 max-w-md w-full text-center space-y-4"
        style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
      >
        {icon}
        <h2 className="text-lg font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** Messages for a toast, one per line. */
function lines(messages: string[]) {
  return <span style={{ whiteSpace: 'pre-line' }}>{messages.join('\n')}</span>;
}

/** Deleting: one orphan (a card's Delete) or all of them (cleanup). */
type Pending = { kind: 'one'; taskId: string } | { kind: 'all' } | null;

export default function WorktreesPage() {
  const projectPath = useProjectStore((s) => s.projectPath);
  const [worktrees, setWorktrees] = useState<WorktreeEntry[] | null>(null);
  const [usage, setUsage] = useState<DiskUsage | null>(null);
  const [usageError, setUsageError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  /** Drops answers from an earlier load (another project, or a reload that overtook it). */
  const loadId = useRef(0);

  const load = useCallback(async () => {
    const id = ++loadId.current;
    setLoading(true);
    setError(null);
    api.worktrees
      .usage()
      .then((u) => {
        if (id !== loadId.current) return;
        setUsage(u);
        setUsageError(false);
      })
      .catch(() => {
        if (id === loadId.current) setUsageError(true);
      });
    try {
      const list = await api.worktrees.list();
      if (id === loadId.current) setWorktrees(list);
    } catch (e) {
      if (id === loadId.current) setError(errorMessage(e));
    } finally {
      if (id === loadId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setWorktrees(null);
    setUsage(null);
    setUsageError(false);
    setError(null);
    if (projectPath) void load();
  }, [projectPath, load]);

  const afterDelete = useCallback(() => {
    useProjectStore.getState().incrementWorktreeRefresh();
    void load();
  }, [load]);

  const deleteOne = async (taskId: string) => {
    try {
      const report = await api.worktrees.removeOrphan(taskId);
      if (report.warnings.length > 0) {
        toast.warning('Orphan worktree deleted with warnings', {
          description: lines(report.warnings),
        });
      } else {
        toast.success('Orphan worktree deleted');
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      afterDelete();
    }
  };

  const deleteAll = async (targets: WorktreeEntry[]) => {
    let removed = 0;
    const problems: string[] = [];
    for (const w of targets) {
      try {
        const report = await api.worktrees.removeOrphan(w.taskId);
        removed += 1;
        problems.push(...report.warnings.map((m) => `${w.taskId}: ${m}`));
      } catch (e) {
        problems.push(`${w.taskId}: ${errorMessage(e)}`);
      }
    }
    const failed = targets.length - removed;
    const summary = cleanupSummary(removed, failed);
    const description = problems.length > 0 ? lines(problems) : undefined;
    if (failed > 0) toast.error(summary, { description });
    else if (problems.length > 0) toast.warning(summary, { description });
    else toast.success(summary);
    afterDelete();
  };

  if (!projectPath) {
    return (
      <CenteredNotice
        testId="worktrees-page"
        icon={
          <HardDrive className="w-12 h-12 mx-auto" style={{ color: 'var(--color-text-muted)' }} />
        }
        title="Open a project"
      >
        <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          Open a project to see its worktrees.
        </p>
      </CenteredNotice>
    );
  }

  if (error && worktrees === null) {
    return (
      <CenteredNotice
        testId="worktrees-page"
        icon={
          <AlertCircle
            className="w-12 h-12 mx-auto"
            style={{ color: 'var(--color-destructive)' }}
          />
        }
        title="Could not load worktrees"
      >
        <p
          data-testid="worktrees-error"
          className="text-sm"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          {error}
        </p>
        <Button
          onClick={() => void load()}
          style={{ backgroundColor: 'var(--color-primary)', color: 'var(--color-primary-text)' }}
        >
          Retry
        </Button>
      </CenteredNotice>
    );
  }

  if (worktrees === null) {
    return (
      <div
        data-testid="worktrees-page"
        className="h-screen flex flex-col items-center justify-center gap-4 p-6"
        style={pageStyle}
      >
        <Loader2 className="w-10 h-10 animate-spin" style={{ color: 'var(--color-primary)' }} />
        <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          Loading worktrees…
        </p>
      </div>
    );
  }

  const orphanList = orphans(worktrees);
  const targets: WorktreeEntry[] =
    pending?.kind === 'all'
      ? orphanList
      : pending?.kind === 'one'
        ? worktrees.filter((w) => w.taskId === pending.taskId)
        : [];

  return (
    <div data-testid="worktrees-page" className="h-screen overflow-y-auto p-6" style={pageStyle}>
      <div className="max-w-4xl mx-auto space-y-6">
        <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <h1 className="text-2xl font-bold">Worktrees</h1>
          <div className="flex flex-wrap items-center gap-3">
            <div
              data-testid="worktrees-usage"
              className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm"
              style={{
                background: 'var(--color-surface)',
                border: '1px solid var(--color-border)',
                color: 'var(--color-text-secondary)',
              }}
            >
              <HardDrive className="w-4 h-4" />
              <span>
                {usage
                  ? `Total: ${formatBytes(usage.totalBytes)}`
                  : usageError
                    ? 'Disk use unavailable'
                    : 'Measuring…'}
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              aria-label="Reload"
              title="Reload"
              data-testid="worktrees-reload"
              onClick={() => void load()}
              disabled={loading}
              style={{
                backgroundColor: 'var(--color-surface)',
                borderColor: 'var(--color-border)',
                color: 'var(--color-text-primary)',
              }}
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              data-testid="worktrees-cleanup"
              disabled={orphanList.length === 0}
              title={orphanList.length === 0 ? 'No orphan worktrees' : undefined}
              onClick={() => setPending({ kind: 'all' })}
              style={{
                backgroundColor: 'var(--color-surface)',
                borderColor: 'var(--color-destructive)',
                color: 'var(--color-destructive)',
              }}
            >
              <Trash2 className="w-4 h-4" />
              Clean up orphans{orphanList.length > 0 ? ` (${orphanList.length})` : ''}
            </Button>
          </div>
        </header>

        {error && (
          <p className="text-sm" style={{ color: 'var(--color-destructive)' }}>
            Reload failed: {error}
          </p>
        )}

        {worktrees.length === 0 ? (
          <div
            data-testid="worktrees-empty"
            className="rounded-lg border p-8 text-center space-y-2"
            style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
          >
            <h2 className="text-lg font-semibold">No worktrees</h2>
            <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
              A task gets its own worktree when it starts.
            </p>
          </div>
        ) : (
          <ul data-testid="worktrees-list" className="grid gap-4 sm:grid-cols-2">
            {worktrees.map((w) => (
              <li key={w.taskId}>
                <WorktreeCard
                  worktree={w}
                  sizeBytes={usage?.perWorktree[w.taskId]}
                  onDelete={(taskId) => setPending({ kind: 'one', taskId })}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <DeleteOrphansModal
        open={pending !== null && targets.length > 0}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        worktrees={targets}
        onConfirm={() => (pending?.kind === 'one' ? deleteOne(pending.taskId) : deleteAll(targets))}
      />
    </div>
  );
}
