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

/** The task's phases, each with its own agent. */
export type AgentPhase = 'planning' | 'dev' | 'qa';

export const AGENT_PHASES: AgentPhase[] = ['planning', 'dev', 'qa'];

export const AGENT_PHASE_LABELS: Record<AgentPhase, string> = {
  planning: 'Planning',
  dev: 'Development',
  qa: 'QA review',
};

/** The agent part of the task forms: one draft per phase, or one for all (`same`). */
export type PhaseDrafts = { same: boolean } & Record<AgentPhase, AgentDraft>;

function sameDraft(a: AgentDraft, b: AgentDraft): boolean {
  return a.provider === b.provider && a.model === b.model && a.mode === b.mode;
}

export function draftsFromAgents(agents: PhaseAgents): PhaseDrafts {
  const drafts = {
    planning: draftFromAgent(agents.planning),
    dev: draftFromAgent(agents.dev),
    qa: draftFromAgent(agents.qa),
  };
  const same = sameDraft(drafts.planning, drafts.dev) && sameDraft(drafts.qa, drafts.dev);
  return { same, ...drafts };
}

/** All three phases on one draft. */
export function sameDrafts(draft: AgentDraft): PhaseDrafts {
  return { same: true, planning: draft, dev: draft, qa: draft };
}

/** The draft each phase uses: the development one for all when `same`. */
export function effectiveDraft(drafts: PhaseDrafts, phase: AgentPhase): AgentDraft {
  return drafts.same ? drafts.dev : drafts[phase];
}

/**
 * The agents the drafts stand for; null until every phase has a provider. `base` keeps each
 * phase's `options` while its provider stays the same.
 */
export function agentsFromDrafts(drafts: PhaseDrafts, base?: PhaseAgents): PhaseAgents | null {
  const one = (phase: AgentPhase) => agentFromDraft(effectiveDraft(drafts, phase), base?.[phase]);
  const planning = one('planning');
  const dev = one('dev');
  const qa = one('qa');
  return planning && dev && qa ? { planning, dev, qa } : null;
}

/** The recommended models per phase: Fable 5.2 to plan and review, Opus 5.5 to develop. */
const CLAUDE_RECOMMENDED: Record<AgentPhase, string> = {
  planning: 'claude-fable-5-2',
  dev: 'claude-opus-5-5',
  qa: 'claude-fable-5-2',
};

/**
 * A new task's drafts: the last choice when its CLIs are still offered, else the first ready CLI,
 * with the recommended models for Claude Code.
 */
export function defaultDrafts(
  providers: ProviderInfo[],
  last: PhaseDrafts | null
): PhaseDrafts | null {
  const offered = new Set(providers.map((p) => p.provider));
  if (
    last &&
    AGENT_PHASES.every((ph) => {
      const p = effectiveDraft(last, ph).provider;
      return p !== null && offered.has(p);
    })
  ) {
    return last;
  }
  const provider = defaultProvider(providers);
  if (!provider) return null;
  if (provider === 'claude') {
    const draft = (phase: AgentPhase): AgentDraft => ({
      provider,
      model: CLAUDE_RECOMMENDED[phase],
      mode: '',
    });
    return { same: false, planning: draft('planning'), dev: draft('dev'), qa: draft('qa') };
  }
  return sameDrafts({ provider, model: '', mode: '' });
}

const LAST_KEY = 'code-automata-last-agents';

/** The last choice made in the new-task form, kept in this browser. */
export function loadLastDrafts(storage: Pick<Storage, 'getItem'> | null): PhaseDrafts | null {
  try {
    const raw = storage?.getItem(LAST_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as PhaseDrafts;
    const ok = (d: unknown): d is AgentDraft =>
      typeof d === 'object' &&
      d !== null &&
      typeof (d as AgentDraft).model === 'string' &&
      typeof (d as AgentDraft).mode === 'string';
    return typeof value.same === 'boolean' && AGENT_PHASES.every((ph) => ok(value[ph]))
      ? value
      : null;
  } catch {
    return null;
  }
}

export function saveLastDrafts(storage: Pick<Storage, 'setItem'> | null, drafts: PhaseDrafts) {
  try {
    storage?.setItem(LAST_KEY, JSON.stringify(drafts));
  } catch {
    // Storage full or off: the next form starts from the defaults.
  }
}

export type TaskForm = {
  title: string;
  description: string;
  agents: PhaseDrafts;
  requirePlanApproval: boolean;
};

export function formFromTask(task: Task): TaskForm {
  return {
    title: task.title,
    description: task.description ?? '',
    agents: draftsFromAgents(task.agents),
    requirePlanApproval: task.requirePlanApproval,
  };
}

export type TaskPatch = Partial<
  Pick<Task, 'title' | 'description' | 'agents' | 'requirePlanApproval'>
>;

/**
 * The fields of `form` that differ from `task`. The agents are compared after both sides go
 * through the same normalisation, so an untouched form never produces an agent change, and they
 * are left out entirely while a run holds them.
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
    const next = agentsFromDrafts(form.agents, task.agents);
    const current = agentsFromDrafts(draftsFromAgents(task.agents), task.agents);
    if (next && current && AGENT_PHASES.some((ph) => !sameAgent(next[ph], current[ph]))) {
      changes.agents = next;
    }
  }
  return changes;
}
