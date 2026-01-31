'use client';

/**
 * Delete Task Modal
 *
 * Confirmation modal for deleting tasks with warning about worktree deletion
 */

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
import type { Task } from '@/lib/tasks/schema';

interface DeleteTaskModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: Task | null;
  onConfirmDelete: () => void;
  isDeleting?: boolean;
}

export function DeleteTaskModal({
  open,
  onOpenChange,
  task,
  onConfirmDelete,
  isDeleting = false,
}: DeleteTaskModalProps) {
  if (!task) return null;

  return (
    <Dialog open={open} onOpenChange={isDeleting ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" style={{ color: 'var(--color-destructive)' }} />
            Delete Task
          </DialogTitle>
          <DialogDescription>
            This action cannot be undone. This will permanently delete the task and its associated
            worktree.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4 py-4">
          {/* Task Details */}
          <div className="space-y-3">
            <div>
              <div
                className="text-sm font-medium mb-1"
                style={{ color: 'var(--color-text-primary)' }}
              >
                Task Title
              </div>
              <div className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                {task.title || task.id}
              </div>
            </div>

            <div>
              <div
                className="text-sm font-medium mb-1"
                style={{ color: 'var(--color-text-primary)' }}
              >
                Description
              </div>
              <div
                className="text-sm line-clamp-3"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                {task.description}
              </div>
            </div>

            {task.branchName && (
              <div>
                <div
                  className="text-sm font-medium mb-1"
                  style={{ color: 'var(--color-text-primary)' }}
                >
                  Branch Name
                </div>
                <div
                  className="text-sm font-mono px-2 py-1 rounded"
                  style={{
                    backgroundColor: 'var(--color-surface-hover)',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  {task.branchName}
                </div>
              </div>
            )}
          </div>

          {/* Warning Box */}
          <div
            className="rounded-md border p-3 space-y-2"
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
                  Warning
                </div>
                <div className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                  Deleting this task will:
                </div>
                <ul
                  className="text-xs space-y-0.5 ml-4 list-disc"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  <li>Permanently delete all task data and subtasks</li>
                  <li>Remove the associated git worktree if it exists</li>
                  <li>Delete any uncommitted changes in the worktree</li>
                  <li>Remove the task from all phases in the workflow</li>
                </ul>
              </div>
            </div>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isDeleting}
            style={{
              background: 'var(--color-surface-hover)',
              color: 'var(--color-text-primary)',
              borderColor: 'var(--color-border)',
            }}
            onMouseEnter={(e) => {
              if (!isDeleting) {
                e.currentTarget.style.background = 'var(--color-background)';
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--color-surface-hover)';
            }}
          >
            Cancel
          </Button>
          <Button
            onClick={onConfirmDelete}
            disabled={isDeleting}
            className="font-medium"
            style={{
              backgroundColor: 'var(--color-destructive)',
              color: 'var(--color-surface)',
            }}
            onMouseEnter={(e) => {
              if (!isDeleting) {
                e.currentTarget.style.opacity = '0.9';
              }
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
              'Delete Task'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
