'use client';

/**
 * Human Review Modal
 *
 * Modal for reviewing completed development and QA work before merging
 * Provides options for:
 * - Creating MR for review (if git enabled)
 * - Review Locally: open worktree in Cursor or VS Code (Electron)
 * - Open in file explorer (Electron)
 */

import { useState, useEffect, useMemo } from 'react';
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
import { Card } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  GitBranch,
  Eye,
  Code2,
  Folder,
  AlertCircle,
  CheckCircle2,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import { Task } from '@/lib/tasks/schema';
import { toast } from 'sonner';
import { useTaskStore } from '@/store/task-store';
import { useProjectStore } from '@/store/project-store';
import type { AvailableEditor } from '@/types/electron';

interface HumanReviewModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: Task;
}

/** Build worktree path without Node path in client (projectPath/.code-auto/worktrees/taskId). */
function buildWorktreePath(projectPath: string | null, taskId: string): string | null {
  if (!projectPath) return null;
  const parts = [projectPath.replace(/\/$/, ''), '.code-auto', 'worktrees', taskId];
  return parts.join('/');
}

/** Filter to available editors and sort with Cursor first. */
function availableEditorsSorted(editors: AvailableEditor[]): AvailableEditor[] {
  const available = editors.filter((e) => e.available !== false);
  return [...available].sort((a, b) => (a.id === 'cursor' ? -1 : b.id === 'cursor' ? 1 : 0));
}

export function HumanReviewModal({ open, onOpenChange, task }: HumanReviewModalProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [mrUrl, setMrUrl] = useState<string | null>(task.mergeRequestUrl || null);
  const [gitStatus, setGitStatus] = useState<{
    hasChanges: boolean;
    status: string;
    clean: boolean;
  } | null>(null);
  const [availableEditors, setAvailableEditors] = useState<AvailableEditor[]>([]);
  const [selectedEditorId, setSelectedEditorId] = useState<AvailableEditor['id'] | null>(null);
  const [editorsLoading, setEditorsLoading] = useState(false);
  const [openingFolder, setOpeningFolder] = useState(false);
  const { loadTasks } = useTaskStore();
  const { projectPath } = useProjectStore();

  const worktreePath = buildWorktreePath(projectPath, task.id);
  const isElectron = typeof window !== 'undefined' && !!window.electron;
  const canUseLocalActions = !!projectPath && isElectron;
  const localActionsMessage = !projectPath
    ? 'No project path set.'
    : !isElectron
      ? 'Use desktop app for Review Locally and Open in File Explorer.'
      : null;

  const selectedEditor = useMemo(
    () => availableEditors.find((e) => e.id === selectedEditorId) ?? availableEditors[0] ?? null,
    [availableEditors, selectedEditorId]
  );

  // Separate dev and QA subtasks
  const devSubtasks = task.subtasks.filter((s) => s.type === 'dev');
  const qaSubtasks = task.subtasks.filter((s) => s.type === 'qa');

  // Check if git is enabled (for now, mock check based on branchName)
  const isGitEnabled = !!task.branchName;

  // Fetch git status when modal opens
  useEffect(() => {
    if (open && task.branchName) {
      fetch(`/api/git/status?taskId=${task.id}`)
        .then((res) => res.json())
        .then((data) => setGitStatus(data))
        .catch((err) => console.error('Failed to fetch git status:', err));
    }
  }, [open, task.id, task.branchName]);

  // Fetch available editors when modal opens (Electron only)
  useEffect(() => {
    if (!open || !isElectron || !window.electron) return;
    setEditorsLoading(true);
    window.electron
      .getAvailableEditors()
      .then((raw) => {
        const sorted = availableEditorsSorted(raw);
        setAvailableEditors(sorted);
        setSelectedEditorId(sorted[0]?.id ?? null);
      })
      .catch((err) => {
        console.error('Failed to get available editors:', err);
        setAvailableEditors([]);
        setSelectedEditorId(null);
      })
      .finally(() => setEditorsLoading(false));
  }, [open, isElectron]);

  const handleCreateMR = async (e: React.MouseEvent) => {
    e.stopPropagation();
    // If already created, just open it
    if (mrUrl) {
      window.open(mrUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    setIsLoading(true);
    try {
      const response = await fetch('/api/git/create-mr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id }),
      });

      const data = await response.json().catch(() => ({}) as Record<string, unknown>);
      if (!response.ok) {
        toast.error(data?.error || 'Failed to create MR');
        return;
      }

      const url = data?.url as string | undefined;
      if (url) {
        setMrUrl(url);
        toast.success('Merge request created');
        // Open in a new tab for convenience
        window.open(url, '_blank', 'noopener,noreferrer');
      } else {
        toast.success('Merge request created');
      }
    } catch (error) {
      console.error('Failed to create MR:', error);
      toast.error('Failed to create MR');
    } finally {
      setIsLoading(false);
    }
  };

  const handleMoveToDone = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsLoading(true);
    try {
      const response = await fetch('/api/tasks/update', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: task.id,
          phase: 'done',
          status: 'completed',
          assignedAgent: undefined,
        }),
      });

      const data = await response.json().catch(() => ({}) as Record<string, unknown>);
      if (!response.ok) {
        toast.error(data?.error || 'Failed to move task to Done');
        return;
      }

      toast.success('Moved task to Done');
      await loadTasks();
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to move task to Done:', error);
      toast.error('Failed to move task to Done');
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenInEditor = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!worktreePath || !selectedEditorId || !window.electron) return;
    try {
      const exists = await window.electron.pathExists(worktreePath);
      if (!exists) {
        toast.error(`Worktree not found at ${worktreePath}`);
        return;
      }
    } catch {
      toast.error(`Worktree not found at ${worktreePath}`);
      return;
    }
    setIsLoading(true);
    try {
      const result = await window.electron.openEditorAtPath(worktreePath, selectedEditorId);
      if (result.success) {
        toast.success(`Opened in ${selectedEditor?.label ?? selectedEditorId}`, {
          description: worktreePath,
        });
      } else {
        toast.error(result.error ?? 'Failed to open editor');
      }
    } catch (error) {
      console.error('Failed to open editor:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to open editor');
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenFolder = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!projectPath || !worktreePath || !window.electron) {
      toast.error(!projectPath ? 'No project path set.' : 'Cannot open folder.');
      return;
    }
    try {
      const exists = await window.electron.pathExists(worktreePath);
      if (!exists) {
        toast.error(`Worktree not found at ${worktreePath}`);
        return;
      }
    } catch {
      toast.error(`Worktree not found at ${worktreePath}`);
      return;
    }
    setOpeningFolder(true);
    try {
      const result = await window.electron.openFolder(worktreePath);
      if (result.success) {
        toast.success('Opened in file explorer', { description: worktreePath });
      } else {
        toast.error(result.error ?? 'Failed to open folder');
      }
    } catch (error) {
      console.error('Failed to open folder:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to open folder');
    } finally {
      setOpeningFolder(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px]">
        <DialogHeader>
          <DialogTitle>Human Review - Ready for Merge</DialogTitle>
          <DialogDescription>
            All development and QA tasks are complete. Review the changes and approve for merge.
          </DialogDescription>
          {task.branchName && (
            <div className="flex items-center gap-2 pt-2">
              <div
                className="flex items-center gap-1.5 px-2 py-1 rounded"
                style={{ background: 'var(--color-surface-hover)' }}
              >
                <GitBranch className="w-3.5 h-3.5" style={{ color: 'var(--color-info)' }} />
                <span className="text-xs font-mono" style={{ color: 'var(--color-text-primary)' }}>
                  {task.branchName}
                </span>
              </div>
              {gitStatus && (
                <div
                  className="flex items-center gap-1 px-2 py-1 rounded border"
                  style={{
                    borderColor: gitStatus.clean ? 'var(--color-success)' : 'var(--color-warning)',
                    background: 'transparent',
                  }}
                >
                  {gitStatus.clean ? (
                    <>
                      <CheckCircle2
                        className="w-3.5 h-3.5"
                        style={{ color: 'var(--color-success)' }}
                      />
                      <span
                        className="text-xs font-medium"
                        style={{ color: 'var(--color-success)' }}
                      >
                        Clean
                      </span>
                    </>
                  ) : (
                    <>
                      <AlertTriangle
                        className="w-3.5 h-3.5"
                        style={{ color: 'var(--color-warning)' }}
                      />
                      <span
                        className="text-xs font-medium"
                        style={{ color: 'var(--color-warning)' }}
                      >
                        Changes
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </DialogHeader>

        <DialogBody className="space-y-6 py-4">
          {/* Completed Work Summary */}
          <div className="space-y-4">
            <h3 className="font-medium text-sm" style={{ color: 'var(--color-text-primary)' }}>
              ✓ Completed Work
            </h3>

            {/* Development Subtasks */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div
                  className="w-3 h-3 rounded-full"
                  style={{ background: 'var(--color-success)' }}
                />
                <span
                  className="text-xs font-medium"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  Development Tasks ({devSubtasks.length})
                </span>
              </div>
              <div className="pl-5 space-y-2">
                {devSubtasks.map((subtask) => (
                  <div
                    key={subtask.id}
                    className="text-xs py-1.5 px-2 rounded"
                    style={{ background: 'var(--color-surface-hover)' }}
                  >
                    <p style={{ color: 'var(--color-text-primary)' }}>{subtask.content}</p>
                    <p className="text-xs mt-1" style={{ color: 'var(--color-text-secondary)' }}>
                      {subtask.label}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            {/* QA Subtasks */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full" style={{ background: '#a78bfa' }} />
                <span
                  className="text-xs font-medium"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  QA Verification Tasks ({qaSubtasks.length})
                </span>
              </div>
              <div className="pl-5 space-y-2">
                {qaSubtasks.map((subtask) => (
                  <div
                    key={subtask.id}
                    className="text-xs py-1.5 px-2 rounded"
                    style={{ background: 'var(--color-surface-hover)' }}
                  >
                    <p style={{ color: 'var(--color-text-primary)' }}>{subtask.content}</p>
                    <p className="text-xs mt-1" style={{ color: 'var(--color-text-secondary)' }}>
                      {subtask.label}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Git-based Review Options */}
          {isGitEnabled ? (
            <div className="space-y-3 pt-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
              <h3 className="font-medium text-sm" style={{ color: 'var(--color-text-primary)' }}>
                <GitBranch className="w-4 h-4 inline mr-2" />
                Git Review Options
              </h3>

              <Card
                className="p-4 cursor-pointer transition-colors"
                style={{
                  background: 'var(--color-surface)',
                  borderColor: 'var(--color-border)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--color-primary)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--color-border)';
                }}
              >
                <div className="space-y-3">
                  <div>
                    <h4
                      className="text-sm font-medium flex items-center gap-2"
                      style={{ color: 'var(--color-text-primary)' }}
                    >
                      <Eye className="w-4 h-4" />
                      Create Merge Request
                    </h4>
                    <p className="text-xs mt-1" style={{ color: 'var(--color-text-secondary)' }}>
                      Push changes and create a merge request for code review
                    </p>
                  </div>
                  <Button
                    onClick={handleCreateMR}
                    disabled={isLoading}
                    size="sm"
                    className="w-full text-xs"
                    style={{
                      background: 'var(--color-primary)',
                      color: 'var(--color-primary-text)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--color-primary-hover)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'var(--color-primary)';
                    }}
                  >
                    {isLoading ? 'Creating...' : mrUrl ? 'View MR' : 'Create MR'}
                  </Button>
                </div>
              </Card>
            </div>
          ) : (
            <div
              className="p-4 rounded border"
              style={{
                background: 'var(--color-warning)',
                borderColor: 'var(--color-warning)',
                opacity: 0.1,
              }}
            >
              <div className="flex gap-2">
                <AlertCircle
                  className="w-4 h-4 flex-shrink-0 mt-0.5"
                  style={{ color: 'var(--color-warning)' }}
                />
                <p className="text-xs" style={{ color: 'var(--color-text-primary)' }}>
                  Git is not enabled for this project. Use the options below to navigate to the
                  project and review changes manually.
                </p>
              </div>
            </div>
          )}

          {/* Review Locally & Open Project */}
          <div className="space-y-3 pt-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <h3 className="font-medium text-sm" style={{ color: 'var(--color-text-primary)' }}>
              <Folder className="w-4 h-4 inline mr-2" />
              Open Project
            </h3>
            {localActionsMessage && (
              <p className="text-xs" style={{ color: 'var(--color-warning)' }}>
                {localActionsMessage}
              </p>
            )}

            {/* Review Locally: open worktree in Cursor or VS Code */}
            <Card
              className="p-4 transition-colors"
              style={{
                background: 'var(--color-surface)',
                borderColor: 'var(--color-border)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-info)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-border)';
              }}
            >
              <div className="space-y-3">
                <div>
                  <h4
                    className="text-sm font-medium flex items-center gap-2"
                    style={{ color: 'var(--color-text-primary)' }}
                  >
                    <Code2 className="w-4 h-4" />
                    Review Locally
                  </h4>
                  <p className="text-xs mt-1" style={{ color: 'var(--color-text-secondary)' }}>
                    Open the worktree in Cursor or VS Code to review changes
                  </p>
                </div>
                {editorsLoading ? (
                  <div
                    className="flex items-center gap-2 text-xs"
                    style={{ color: 'var(--color-text-secondary)' }}
                  >
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Detecting editors…
                  </div>
                ) : availableEditors.length === 0 ? (
                  <>
                    <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                      No IDE found.
                    </p>
                    <Button
                      disabled
                      size="sm"
                      className="flex-1 sm:flex-initial text-xs"
                      style={{
                        background: 'var(--color-surface-hover)',
                        color: 'var(--color-text-secondary)',
                        borderColor: 'var(--color-border)',
                        cursor: 'not-allowed',
                      }}
                    >
                      Review Locally
                    </Button>
                  </>
                ) : (
                  <div className="flex flex-col sm:flex-row gap-2">
                    {availableEditors.length > 1 ? (
                      <Select
                        value={selectedEditorId ?? ''}
                        onValueChange={(v) =>
                          setSelectedEditorId(v === 'cursor' || v === 'vscode' ? v : null)
                        }
                      >
                        <SelectTrigger className="w-full sm:w-[180px] h-9 text-xs">
                          <SelectValue placeholder="Choose editor" />
                        </SelectTrigger>
                        <SelectContent>
                          {availableEditors.map((e) => (
                            <SelectItem
                              key={e.id}
                              value={e.id}
                              className="text-xs flex items-center gap-2"
                            >
                              <Code2 className="w-3.5 h-3.5" />
                              {e.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <div
                        className="flex items-center gap-2 px-2 py-1.5 rounded text-xs"
                        style={{
                          background: 'var(--color-surface-hover)',
                          color: 'var(--color-text-primary)',
                        }}
                      >
                        <Code2 className="w-3.5 h-3.5" />
                        {selectedEditor?.label ?? 'Editor'}
                      </div>
                    )}
                    <Button
                      onClick={handleOpenInEditor}
                      disabled={isLoading || !canUseLocalActions || !selectedEditorId}
                      size="sm"
                      className="flex-1 sm:flex-initial text-xs"
                      style={{
                        background: 'var(--color-primary)',
                        color: 'var(--color-primary-text)',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'var(--color-primary-hover)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'var(--color-primary)';
                      }}
                    >
                      {isLoading ? 'Opening…' : `Open in ${selectedEditor?.label ?? 'Editor'}`}
                    </Button>
                  </div>
                )}
              </div>
            </Card>

            <Card
              className="p-4 cursor-pointer transition-colors"
              style={{
                background: 'var(--color-surface)',
                borderColor: 'var(--color-border)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-info)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-border)';
              }}
            >
              <div className="space-y-2">
                <h4 className="text-xs font-medium" style={{ color: 'var(--color-text-primary)' }}>
                  File Explorer
                </h4>
                <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                  Browse files
                </p>
                <Button
                  onClick={handleOpenFolder}
                  disabled={openingFolder || !canUseLocalActions}
                  size="sm"
                  variant="outline"
                  className="w-full text-xs mt-2"
                  style={{
                    background: 'var(--color-surface-hover)',
                    color: 'var(--color-text-primary)',
                    borderColor: 'var(--color-border)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--color-background)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'var(--color-surface-hover)';
                  }}
                >
                  {openingFolder ? 'Opening…' : 'Open'}
                </Button>
              </div>
            </Card>
          </div>

          {/* Task Info */}
          <div className="pt-2 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              <span className="font-medium">Task ID:</span> {task.id}
            </p>
          </div>
        </DialogBody>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="text-xs"
            style={{
              background: 'var(--color-surface-hover)',
              color: 'var(--color-text-primary)',
              borderColor: 'var(--color-border)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--color-background)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--color-surface-hover)';
            }}
          >
            Close
          </Button>
          <Button
            style={{
              background: 'var(--color-success)',
              color: '#ffffff',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--color-success)';
              e.currentTarget.style.opacity = '0.9';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--color-success)';
              e.currentTarget.style.opacity = '1';
            }}
            className="text-xs"
            onClick={handleMoveToDone}
            disabled={isLoading}
          >
            {isLoading ? 'Moving...' : 'Move to Done'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
