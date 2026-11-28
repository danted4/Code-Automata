/**
 * Rules behind the new-task and edit-task forms: provider readiness, the default agent, turning
 * the form into an `AgentConfig`, and the patch an edit sends. Pure, so the modals only render.
 */

import type { AgentConfig } from '@/lib/api/types/AgentConfig';
import type { PhaseAgents } from '@/lib/api/types/PhaseAgents';
import type { Preflight } from '@/lib/api/types/Preflight';
import type { Provider } from '@/lib/api/types/Provider';
import type { ProviderInfo } from '@/lib/api/types/ProviderInfo';
import type { Run } from '@/lib/api/types/Run';
import type { Task } from '@/lib/api/types/Task';

/** The agent part of a form, as typed. `provider` is null until the providers have loaded. */
export type AgentDraft = { provider: Provider | null; model: string; mode: string };

export const EMPTY_AGENT_DRAFT: AgentDraft = { provider: null, model: '', mode: '' };

/** Providers that take a `mode` (Amp's mode, Codex's reasoning effort); the others ignore it. */
const MODE_PROVIDERS: Provider[] = ['amp', 'codex'];

export function takesMode(provider: Provider | null): boolean {
  return provider !== null && MODE_PROVIDERS.includes(provider);
}

/** A suggested mode for the provider, shown as a placeholder. */
export function suggestedMode(provider: Provider | null): string | null {
  if (provider === 'amp') return 'low';
  if (provider === 'codex') return 'medium';
  return null;
}

export type Readiness = { ready: boolean; label: string };

/** Same rule as the server's `Preflight::ready`: installed, logged in, nothing to fix. */
export function readiness(p: Preflight): Readiness {
  if (p.binary !== null && p.loggedIn === true && p.problem === null) {
    return { ready: true, label: 'Ready' };
  }
  if (p.binary === null) return { ready: false, label: 'Not installed' };
  if (p.loggedIn === false) return { ready: false, label: 'Not logged in' };
  if (p.loggedIn === null) return { ready: false, label: 'Login unknown' };
  return { ready: false, label: 'Not ready' };
}

/** The first ready provider, else the first one offered, else null. */
export function defaultProvider(providers: ProviderInfo[]): Provider | null {
  const ready = providers.find((p) => readiness(p.preflight).ready);
  return (ready ?? providers[0])?.provider ?? null;
}

/** The same agent for every phase. */
export function sameForAll(agent: AgentConfig): PhaseAgents {
  return { planning: agent, dev: agent, qa: agent };
}

export function draftFromAgent(agent: AgentConfig): AgentDraft {
  return { provider: agent.provider, model: agent.model ?? '', mode: agent.mode ?? '' };
}

/**
 * The agent config a draft stands for, with empty fields left out. `base` is the task's current
 * agent: its `options` are kept while the provider stays the same (the form does not edit them).
 */
export function agentFromDraft(draft: AgentDraft, base?: AgentConfig): AgentConfig | null {
  if (!draft.provider) return null;
  const agent: AgentConfig = { provider: draft.provider };
  const model = draft.model.trim();
  const mode = draft.mode.trim();
  if (model) agent.model = model;
  if (mode && takesMode(draft.provider)) agent.mode = mode;
  if (base && base.provider === draft.provider && base.options) agent.options = base.options;
  return agent;
}

function sameAgent(a: AgentConfig, b: AgentConfig): boolean {
  return (
    a.provider === b.provider &&
    (a.model ?? null) === (b.model ?? null) &&
    (a.mode ?? null) === (b.mode ?? null) &&
    JSON.stringify(a.options ?? null) === JSON.stringify(b.options ?? null)
  );
}

/** Why the agent cannot change right now, or null when it can. */
export function agentLockedReason(run: Run | null | undefined): string | null {
  if (!run) return null;
  switch (run.state) {
    case 'queued':
    case 'running':
      return 'The agent cannot change while it is working on this task.';
    case 'paused':
      return 'The agent cannot change while the task is paused mid-step. Resume it and let the step finish first.';
    case 'interrupted':
      return 'The agent cannot change while a step is interrupted. Resume it and let the step finish first.';
    case 'failed':
      return 'The agent cannot change while a failed step is waiting to be retried.';
    case 'rate_limited':
      return null; // a task waiting out one CLI's limit may move to another
    case 'done':
      return 'The agent cannot change while a step is still being recorded.';
  }
}

export type TaskForm = {
  title: string;
  description: string;
  agent: AgentDraft;
  requirePlanApproval: boolean;
};

export function formFromTask(task: Task): TaskForm {
  return {
    title: task.title,
    description: task.description ?? '',
    agent: draftFromAgent(task.agents.dev),
    requirePlanApproval: task.requirePlanApproval,
  };
}

export type TaskPatch = Partial<
  Pick<Task, 'title' | 'description' | 'agents' | 'requirePlanApproval'>
>;

/**
 * The fields of `form` that differ from `task`. The agent is compared after both sides go through
 * the same normalisation, so an untouched form never produces an agent change, and it is left out
 * entirely while a run holds it.
 */
export function taskChanges(task: Task, form: TaskForm): TaskPatch {
  const changes: TaskPatch = {};
  const title = form.title.trim();
  if (title !== task.title) changes.title = title;
  const description = form.description.trim();
  if (description !== (task.description ?? '').trim()) changes.description = description;
  if (form.requirePlanApproval !== task.requirePlanApproval) {
    changes.requirePlanApproval = form.requirePlanApproval;
  }
  if (agentLockedReason(task.run) === null) {
    const base = task.agents.dev;
    const next = agentFromDraft(form.agent, base);
    const current = agentFromDraft(draftFromAgent(base), base);
    if (next && current && !sameAgent(next, current)) {
      // The form edits the development agent; a phase that used the same one follows it, and a
      // phase with its own agent keeps it.
      const follow = (phase: AgentConfig) => (sameAgent(phase, base) ? next : phase);
      changes.agents = {
        planning: follow(task.agents.planning),
        dev: next,
        qa: follow(task.agents.qa),
      };
    }
  }
  return changes;
}
