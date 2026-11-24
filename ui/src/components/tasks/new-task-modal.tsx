/**
 * New Task Modal: title, description, agent and plan review. The server starts planning as soon as
 * the task is created.
 */

import { type FormEvent, useState } from 'react';
import { Loader2 } from 'lucide-react';
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
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage } from '@/lib/api';
import { EMPTY_AGENT_DRAFT, agentFromDraft, defaultProvider } from '@/lib/agent-form';
import { useTaskStore } from '@/store/task-store';
import { AgentPicker, useProviders } from './agent-picker';

type NewTaskModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function NewTaskModal({ open, onOpenChange }: NewTaskModalProps) {
  const [creating, setCreating] = useState(false);
  return (
    <Dialog open={open} onOpenChange={creating ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-[600px]" data-testid="new-task-modal">
        <DialogHeader>
          <DialogTitle>New Task</DialogTitle>
          <DialogDescription>
            Describe the work and pick the agent. Planning starts as soon as the task is created.
          </DialogDescription>
        </DialogHeader>
        {/* Inside the content, so the form starts empty each time the dialog opens. */}
        <NewTaskForm
          creating={creating}
          setCreating={setCreating}
          close={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function NewTaskForm({
  creating,
  setCreating,
  close,
}: {
  creating: boolean;
  setCreating: (creating: boolean) => void;
  close: () => void;
}) {
  const providersState = useProviders();
  const { providers } = providersState;
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [agentDraft, setAgentDraft] = useState(EMPTY_AGENT_DRAFT);
  const [requirePlanApproval, setRequirePlanApproval] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Until the user picks one, the agent is the first ready provider.
  const draft = {
    ...agentDraft,
    provider: agentDraft.provider ?? (providers ? defaultProvider(providers) : null),
  };
  const agent = agentFromDraft(draft);
  const canSubmit = !creating && title.trim() !== '' && agent !== null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !agent) return;
    setCreating(true);
    setError(null);
    try {
      const task = await api.tasks.create({
        title: title.trim(),
        description: description.trim(),
        agent,
        requirePlanApproval,
      });
      useTaskStore.getState().upsert(task);
      toast.success('Task created');
      setCreating(false);
      close();
    } catch (e) {
      setError(errorMessage(e));
      setCreating(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
      <DialogBody className="space-y-4 py-2">
        <div className="space-y-2">
          <Label htmlFor="new-task-title">Title *</Label>
          <Input
            id="new-task-title"
            data-testid="new-task-title"
            placeholder="What should be done, in a few words"
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="new-task-description">Description</Label>
          <Textarea
            id="new-task-description"
            data-testid="new-task-description"
            placeholder="Details, constraints, acceptance criteria…"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
          />
        </div>

        <div className="border-t pt-4" style={{ borderColor: 'var(--color-border)' }}>
          <AgentPicker state={providersState} value={draft} onChange={setAgentDraft} />
        </div>

        <div
          className="flex items-start gap-3 border-t pt-4"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <Checkbox
            id="new-task-plan-approval"
            data-testid="new-task-plan-approval"
            checked={requirePlanApproval}
            onCheckedChange={(checked) => setRequirePlanApproval(checked === true)}
            className="mt-0.5"
          />
          <div className="flex-1 space-y-1">
            <Label htmlFor="new-task-plan-approval" className="cursor-pointer">
              Review the plan before development
            </Label>
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {requirePlanApproval
                ? 'Planning asks you clarifying questions and waits for you to approve the plan.'
                : 'Planning runs straight through to development without stopping.'}
            </p>
          </div>
        </div>

        {error && (
          <p
            className="rounded-md border p-3 text-sm"
            style={{ borderColor: 'var(--color-error)', color: 'var(--color-error)' }}
            data-testid="new-task-error"
          >
            {error}
          </p>
        )}
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={close} disabled={creating}>
          Cancel
        </Button>
        <Button
          type="submit"
          data-testid="new-task-submit"
          disabled={!canSubmit}
          style={{ background: 'var(--color-primary)', color: 'var(--color-primary-text)' }}
        >
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create Task'}
        </Button>
      </DialogFooter>
    </form>
  );
}
