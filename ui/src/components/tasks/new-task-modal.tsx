/**
 * New Task Modal: title, description, agent and plan review. The server starts planning as soon as
 * the task is created.
 */

import { type FormEvent, useEffect, useState } from 'react';
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
import {
  type PhaseDrafts,
  agentsFromDrafts,
  defaultDrafts,
  loadLastDrafts,
  saveLastDrafts,
} from '@/lib/agent-form';
import { useTaskStore } from '@/store/task-store';
import { PhaseAgentPicker, useProviders } from './agent-picker';

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

/** The page's storage, if it has one (reading it throws when site data is blocked). */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
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
  const [chosen, setChosen] = useState<PhaseDrafts | null>(null);
  // Claude Code's model list: the recommended defaults apply only to models it has.
  const [claudeModels, setClaudeModels] = useState<string[] | null>(null);
  const claudeOffered = providers?.some((p) => p.provider === 'claude') ?? false;
  useEffect(() => {
    if (!claudeOffered) return;
    let live = true;
    api
      .models('claude')
      .then((l) => live && setClaudeModels(l.models.map((m) => m.id)))
      .catch(() => live && setClaudeModels([]));
    return () => {
      live = false;
    };
  }, [claudeOffered]);
  const [requirePlanApproval, setRequirePlanApproval] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Until the user picks, the agents are the last choice or the first ready CLI.
  const drafts =
    chosen ??
    (providers ? defaultDrafts(providers, loadLastDrafts(storage()), claudeModels) : null);
  const agents = drafts ? agentsFromDrafts(drafts) : null;
  const canSubmit = !creating && title.trim() !== '' && agents !== null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !agents || !drafts) return;
    setCreating(true);
    setError(null);
    try {
      const task = await api.tasks.create({
        title: title.trim(),
        description: description.trim(),
        agents,
        requirePlanApproval,
      });
      useTaskStore.getState().upsert(task);
      saveLastDrafts(storage(), drafts);
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
          {drafts ? (
            <PhaseAgentPicker state={providersState} value={drafts} onChange={setChosen} />
          ) : (
            <PhaseAgentPicker
              state={providersState}
              value={{
                same: true,
                planning: { provider: null, model: '', mode: '' },
                dev: { provider: null, model: '', mode: '' },
                qa: { provider: null, model: '', mode: '' },
              }}
              onChange={setChosen}
            />
          )}
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
