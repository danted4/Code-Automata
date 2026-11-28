/**
 * Edit Task Modal: title, description, agent and plan review. Sends only the fields that changed.
 * The agent is read-only while the task has a run.
 */

import { type FormEvent, useState } from 'react';
import { Loader2 } from 'lucide-react';
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
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import type { Task } from '@/lib/api/types/Task';
import {
  type TaskForm,
  agentLockedReason,
  draftsFromAgents,
  formFromTask,
  taskChanges,
} from '@/lib/agent-form';
import { act, useTask } from '@/store/task-store';
import { PhaseAgentPicker, useProviders } from './agent-picker';
import type { TaskModalProps } from './modal-props';

export function EditTaskModal({ taskId, open, onOpenChange }: TaskModalProps) {
  const task = useTask(taskId);
  const [saving, setSaving] = useState(false);
  if (!task) return null;

  return (
    <Dialog open={open} onOpenChange={saving ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-[600px]" data-testid="edit-task-modal">
        <DialogHeader>
          <DialogTitle>Edit Task</DialogTitle>
          <DialogDescription>Changes apply from the next agent run.</DialogDescription>
        </DialogHeader>
        {/* Inside the content, so the form starts from the task each time the dialog opens. */}
        <EditTaskForm
          task={task}
          saving={saving}
          setSaving={setSaving}
          close={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function EditTaskForm({
  task,
  saving,
  setSaving,
  close,
}: {
  task: Task;
  saving: boolean;
  setSaving: (saving: boolean) => void;
  close: () => void;
}) {
  const providersState = useProviders();
  const [form, setForm] = useState<TaskForm>(() => formFromTask(task));
  const set = (patch: Partial<TaskForm>) => setForm((f) => ({ ...f, ...patch }));

  // `task` is live: a run can start while the dialog is open.
  const lockedReason = agentLockedReason(task.run);
  const titleMissing = form.title.trim() === '';
  const changes = taskChanges(task, form);
  const changed = Object.keys(changes).length > 0;
  const canSave = !saving && !titleMissing && changed;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    const updated = await act(() => api.tasks.patch(task.id, changes), 'Task updated');
    setSaving(false);
    if (updated) close();
  };

  return (
    <form onSubmit={save} className="flex min-h-0 flex-1 flex-col gap-4">
      <DialogBody className="space-y-4 py-2">
        <div className="space-y-2">
          <Label htmlFor="edit-task-title">Title *</Label>
          <Input
            id="edit-task-title"
            data-testid="edit-task-title"
            value={form.title}
            aria-invalid={titleMissing}
            onChange={(e) => set({ title: e.target.value })}
          />
          {titleMissing && (
            <p
              className="text-xs"
              style={{ color: 'var(--color-error)' }}
              data-testid="edit-task-title-error"
            >
              A title is required.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="edit-task-description">Description</Label>
          <Textarea
            id="edit-task-description"
            data-testid="edit-task-description"
            value={form.description}
            onChange={(e) => set({ description: e.target.value })}
            rows={4}
          />
        </div>

        <div className="border-t pt-4" style={{ borderColor: 'var(--color-border)' }}>
          <PhaseAgentPicker
            state={providersState}
            value={lockedReason ? draftsFromAgents(task.agents) : form.agents}
            onChange={(agents) => set({ agents })}
            lockedReason={lockedReason}
          />
        </div>

        <div
          className="flex items-start gap-3 border-t pt-4"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <Checkbox
            id="edit-task-plan-approval"
            data-testid="edit-task-plan-approval"
            checked={form.requirePlanApproval}
            onCheckedChange={(checked) => set({ requirePlanApproval: checked === true })}
            className="mt-0.5"
          />
          <div className="flex-1 space-y-1">
            <Label htmlFor="edit-task-plan-approval" className="cursor-pointer">
              Review the plan before development
            </Label>
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              Planning asks clarifying questions and waits for you to approve the plan.
            </p>
          </div>
        </div>
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={close} disabled={saving}>
          Cancel
        </Button>
        <Button
          type="submit"
          data-testid="edit-task-save"
          disabled={!canSave}
          style={{ background: 'var(--color-primary)', color: 'var(--color-primary-text)' }}
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
        </Button>
      </DialogFooter>
    </form>
  );
}
