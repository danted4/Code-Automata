/**
 * Plan Review Modal: the plan waiting for approval. The user approves it (development starts),
 * asks the agent for changes (a revision run rewrites it while the modal waits), or edits the
 * text directly. The task is read live from the store, so a revised plan appears in place.
 */

import { useState } from 'react';
import { ArrowLeft, CheckCircle, Loader2, MessageSquare, Pencil, Save } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { planReviewState, type PlanReviewState } from '@/lib/planning';
import { act, useTask } from '@/store/task-store';
import type { TaskModalProps } from './modal-props';
import { PlanMarkdown } from './plan-markdown';

type Mode = 'view' | 'feedback' | 'edit';

const primaryButton = { background: 'var(--color-primary)', color: 'var(--color-primary-text)' };
const successButton = { background: 'var(--color-success)', color: '#ffffff' };

export function PlanReviewModal({ taskId, open, onOpenChange }: TaskModalProps) {
  const task = useTask(taskId);
  const [mode, setMode] = useState<Mode>('view');
  const [feedback, setFeedback] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  if (!task) return null;

  const state = planReviewState(task);
  const plan = task.planning.plan ?? '';
  const canAct = state.kind === 'reviewable' && !busy;

  const handleOpenChange = (next: boolean) => {
    if (!next) setMode('view');
    onOpenChange(next);
  };

  const run = async (command: Parameters<typeof act>[0], success: string) => {
    setBusy(true);
    const result = await act(command, success);
    setBusy(false);
    return result;
  };

  const approve = async () => {
    if (await run(() => api.tasks.approvePlan(task.id), 'Plan approved')) handleOpenChange(false);
  };

  const sendFeedback = async () => {
    const done = await run(
      () => api.tasks.revisePlan(task.id, feedback.trim()),
      'Revision requested'
    );
    if (done) {
      setFeedback('');
      setMode('view');
    }
  };

  const saveEdit = async () => {
    if (await run(() => api.tasks.editPlan(task.id, draft), 'Plan saved')) setMode('view');
  };

  const startEdit = () => {
    setDraft(plan);
    setMode('edit');
  };

  const closed = state.kind === 'closed';

  return (
    <Dialog open={open} onOpenChange={busy ? undefined : handleOpenChange}>
      <DialogContent className="sm:max-w-[900px]" data-testid="plan-review-modal">
        <DialogHeader>
          <DialogTitle>
            {mode === 'edit'
              ? 'Edit Plan'
              : mode === 'feedback'
                ? 'Request Changes'
                : 'Review Implementation Plan'}
          </DialogTitle>
          <DialogDescription>{task.title}</DialogDescription>
        </DialogHeader>

        <StateNotice state={state} />

        <DialogBody className="flex flex-col gap-3">
          {mode === 'feedback' && !closed && (
            <div className="flex flex-col gap-2">
              <label
                htmlFor="plan-feedback"
                className="text-sm font-medium"
                style={{ color: 'var(--color-text-primary)' }}
              >
                What should change?
              </label>
              <Textarea
                id="plan-feedback"
                data-testid="plan-feedback"
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="For example: split the migration into its own step, and add tests for the error paths."
                rows={5}
                autoFocus
              />
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                The agent rewrites the plan from your feedback. The plan below is the current one.
              </p>
            </div>
          )}

          {mode === 'edit' && !closed ? (
            <Textarea
              data-testid="plan-edit-text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="font-mono text-xs min-h-[420px] flex-1"
              style={{ background: 'var(--color-background)' }}
              spellCheck={false}
            />
          ) : plan ? (
            <div
              className="rounded-lg border px-4 py-3"
              style={{
                background: 'var(--color-background)',
                borderColor: 'var(--color-border)',
                opacity: state.kind === 'revising' ? 0.6 : 1,
              }}
              data-testid="plan-content"
            >
              <PlanMarkdown markdown={plan} />
            </div>
          ) : (
            <p
              className="text-sm"
              style={{ color: 'var(--color-text-muted)' }}
              data-testid="plan-content"
            >
              There is no plan yet.
            </p>
          )}
        </DialogBody>

        <DialogFooter className="gap-2">
          {closed ? (
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              Close
            </Button>
          ) : mode === 'view' ? (
            <>
              <Button
                variant="outline"
                onClick={startEdit}
                disabled={!canAct}
                data-testid="plan-edit"
              >
                <Pencil className="w-4 h-4" />
                Edit
              </Button>
              <Button
                variant="outline"
                onClick={() => setMode('feedback')}
                disabled={!canAct}
                data-testid="plan-request-changes"
              >
                <MessageSquare className="w-4 h-4" />
                Request Changes
              </Button>
              <Button
                onClick={approve}
                disabled={!canAct}
                style={successButton}
                data-testid="plan-approve"
              >
                {busy ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <CheckCircle className="w-4 h-4" />
                )}
                Approve
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => setMode('view')}
                disabled={busy}
                data-testid="plan-back"
              >
                <ArrowLeft className="w-4 h-4" />
                Back
              </Button>
              {mode === 'feedback' ? (
                <Button
                  onClick={sendFeedback}
                  disabled={!canAct || !feedback.trim()}
                  style={primaryButton}
                  data-testid="plan-send-feedback"
                >
                  {busy ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <MessageSquare className="w-4 h-4" />
                  )}
                  Send Feedback
                </Button>
              ) : (
                <Button
                  onClick={saveEdit}
                  disabled={!canAct || !draft.trim()}
                  style={primaryButton}
                  data-testid="plan-save-edit"
                >
                  {busy ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4" />
                  )}
                  Save Plan
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A line above the plan saying why it cannot be acted on, if it cannot. */
function StateNotice({ state }: { state: PlanReviewState }) {
  let text: string;
  let color = 'var(--color-text-secondary)';
  let spinner = false;
  let testId = 'plan-status';
  switch (state.kind) {
    case 'reviewable':
      return null;
    case 'revising':
      text = 'Revising the plan…';
      spinner = true;
      testId = 'plan-revising';
      break;
    case 'working':
      text = `${state.label}…`;
      spinner = true;
      break;
    case 'revision_halted':
      color = state.status.kind === 'failed' ? 'var(--color-error)' : 'var(--color-warning)';
      text =
        state.status.kind === 'failed'
          ? `The revision failed: ${state.status.error.replace(/\.$/, '')}. Retry it from the task card.`
          : state.status.kind === 'ready'
            ? 'The revision has not started. Press Start on the task card to write it.'
            : 'The revision stopped before it finished. Resume the task to continue it.';
      break;
    case 'closed':
      text = `${state.message} There is nothing to review here.`;
      break;
  }
  return (
    <div
      className="shrink-0 flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
      style={{ borderColor: 'var(--color-border)', color }}
      data-testid={testId}
    >
      {spinner && <Loader2 className="w-4 h-4 animate-spin" />}
      {text}
    </div>
  );
}
