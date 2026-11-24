/**
 * Delete Task Modal: confirms, then stops the task's agent and removes its worktree, branch and
 * files.
 */

import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
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
import { api, errorMessage } from '@/lib/api';
import { useTask, useTaskStore } from '@/store/task-store';
import type { TaskModalProps } from './modal-props';

export function DeleteTaskModal({ taskId, open, onOpenChange }: TaskModalProps) {
  const task = useTask(taskId);
  const [deleting, setDeleting] = useState(false);
  if (!task) return null;

  const confirm = async () => {
    setDeleting(true);
    try {
      await api.tasks.remove(task.id);
      useTaskStore.getState().remove(task.id);
      toast.success('Task deleted');
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={deleting ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-[500px]" data-testid="delete-task-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" style={{ color: 'var(--color-destructive)' }} />
            Delete Task
          </DialogTitle>
          <DialogDescription>
            Delete &ldquo;{task.title}&rdquo;? A running agent is stopped first.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            This removes the task, its logs, its worktree and its branch{' '}
            <code className="font-mono">code-automata/{task.id}</code>, including any work that is
            not in a pull request. It cannot be undone.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button
            data-testid="confirm-delete-task"
            onClick={confirm}
            disabled={deleting}
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
