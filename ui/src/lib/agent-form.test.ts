import { describe, expect, it } from 'vitest';
import type { Preflight } from '@/lib/api/types/Preflight';
import type { ProviderInfo } from '@/lib/api/types/ProviderInfo';
import type { Run } from '@/lib/api/types/Run';
import type { Task } from '@/lib/api/types/Task';
import {
  agentsFromDrafts,
  defaultDrafts,
  loadLastDrafts,
  saveLastDrafts,
  sameDrafts,
  agentFromDraft,
  agentLockedReason,
  defaultProvider,
  formFromTask,
  readiness,
  taskChanges,
} from './agent-form';

function preflight(over: Partial<Preflight> = {}): Preflight {
  return {
    provider: 'claude',
    binary: '/usr/local/bin/claude',
    source: 'path',
    chosen: null,
    version: '1.0.0',
    loggedIn: true,
    problem: null,
    ...over,
  };
}

function info(provider: ProviderInfo['provider'], over: Partial<Preflight> = {}): ProviderInfo {
  return { provider, label: provider, preflight: preflight({ provider, ...over }) };
}

function task(over: Partial<Task> = {}): Task {
  return {
    schema: 1,
    id: 'task-1',
    title: 'T',
    description: 'D',
    createdAt: 0,
    updatedAt: 0,
    phase: 'planning',
    agents: {
      planning: { provider: 'claude' },
      dev: { provider: 'claude' },
      qa: { provider: 'claude' },
    },
    requirePlanApproval: false,
    planning: { stage: 'not_started' },
    ...over,
  };
}

const run: Run = {
  id: 'r',
  kind: 'plan',
  state: 'running',
  attempt: 1,
  startedAt: 0,
  updatedAt: 0,
};

describe('readiness', () => {
  it('needs the binary, a confirmed login and no problem', () => {
    expect(readiness(preflight())).toEqual({ ready: true, label: 'Ready' });
    expect(readiness(preflight({ binary: null, loggedIn: null, problem: 'not found' })).label).toBe(
      'Not installed'
    );
    expect(readiness(preflight({ loggedIn: false, problem: 'log in' })).label).toBe(
      'Not logged in'
    );
    expect(readiness(preflight({ loggedIn: null, problem: 'could not check' })).label).toBe(
      'Login unknown'
    );
    expect(readiness(preflight({ problem: 'something' })).ready).toBe(false);
  });
});

describe('defaultProvider', () => {
  it('picks the first ready provider in display order', () => {
    expect(
      defaultProvider([info('claude', { loggedIn: false }), info('cursor'), info('amp')])
    ).toBe('cursor');
  });

  it('falls back to the first provider when none is ready, and null when there are none', () => {
    expect(defaultProvider([info('claude', { binary: null }), info('amp', { binary: null })])).toBe(
      'claude'
    );
    expect(defaultProvider([])).toBeNull();
  });
});

describe('agentFromDraft', () => {
  it('omits empty fields and never invents options', () => {
    expect(agentFromDraft({ provider: 'claude', model: '  ', mode: '' })).toEqual({
      provider: 'claude',
    });
    expect(agentFromDraft({ provider: 'amp', model: '', mode: ' low ' })).toEqual({
      provider: 'amp',
      mode: 'low',
    });
  });

  it('drops mode for providers that ignore it', () => {
    expect(agentFromDraft({ provider: 'cursor', model: 'gpt-5', mode: 'low' })).toEqual({
      provider: 'cursor',
      model: 'gpt-5',
    });
  });

  it('keeps the base options only while the provider is the same', () => {
    const base = { provider: 'claude' as const, options: { permissionMode: 'plan' } };
    expect(agentFromDraft({ provider: 'claude', model: '', mode: '' }, base)).toEqual(base);
    expect(agentFromDraft({ provider: 'amp', model: '', mode: '' }, base)).toEqual({
      provider: 'amp',
    });
  });

  it('is null without a provider', () => {
    expect(agentFromDraft({ provider: null, model: 'x', mode: '' })).toBeNull();
  });
});

describe('taskChanges', () => {
  it('is empty for an untouched form', () => {
    const amp = { provider: 'amp' as const, mode: 'low', options: { a: 1 } };
    const t = task({ agents: { planning: amp, dev: amp, qa: amp } });
    expect(taskChanges(t, formFromTask(t))).toEqual({});
  });

  it('sends only the fields that changed, trimmed', () => {
    const t = task();
    const form = formFromTask(t);
    expect(taskChanges(t, { ...form, title: ' New ' })).toEqual({ title: 'New' });
    expect(taskChanges(t, { ...form, description: '' })).toEqual({ description: '' });
    expect(taskChanges(t, { ...form, requirePlanApproval: true })).toEqual({
      requirePlanApproval: true,
    });
    expect(
      taskChanges(t, {
        ...form,
        agents: sameDrafts({ provider: 'claude', model: 'opus', mode: '' }),
      })
    ).toEqual({
      agents: {
        planning: { provider: 'claude', model: 'opus' },
        dev: { provider: 'claude', model: 'opus' },
        qa: { provider: 'claude', model: 'opus' },
      },
    });
  });

  it('leaves the agent out while a run holds it', () => {
    const t = task({ run });
    const form = formFromTask(t);
    expect(
      taskChanges(t, { ...form, agents: sameDrafts({ provider: 'amp', model: '', mode: '' }) })
    ).toEqual({});
  });
});

describe('agentLockedReason', () => {
  it('is null without a run and says why with one', () => {
    expect(agentLockedReason(null)).toBeNull();
    expect(agentLockedReason(run)).toMatch(/cannot change/);
    expect(agentLockedReason({ ...run, state: 'failed' })).toMatch(/cannot change/);
  });
});

describe('agentLockedReason', () => {
  it('lets a rate-limited task move to another CLI', () => {
    const limited = {
      id: 'r',
      kind: 'dev',
      state: 'rate_limited',
      attempt: 1,
      startedAt: 0,
      updatedAt: 0,
      resetsAt: 1,
    } as const;
    expect(agentLockedReason(limited)).toBeNull();
    expect(agentLockedReason({ ...limited, state: 'paused' })).not.toBeNull();
  });
});

describe('per-phase agents', () => {
  const claudeInfo = (ready: boolean) => ({
    provider: 'claude' as const,
    label: 'Claude Code',
    preflight: {
      provider: 'claude' as const,
      binary: ready ? '/bin/claude' : null,
      source: null,
      chosen: null,
      version: null,
      loggedIn: ready,
      problem: null,
    },
  });
  const mockInfo = {
    provider: 'mock' as const,
    label: 'Mock',
    preflight: { ...claudeInfo(true).preflight, provider: 'mock' as const },
  };

  it('changes only the phase the form changed, keeping the others and their options', () => {
    const t = task({
      agents: {
        planning: { provider: 'claude', model: 'claude-fable-5-2' },
        dev: { provider: 'claude', options: { maxTurns: 40 } },
        qa: { provider: 'claude' },
      },
    });
    const form = formFromTask(t);
    expect(form.agents.same).toBe(false);
    const agents = { ...form.agents, qa: { provider: 'cursor' as const, model: '', mode: '' } };
    expect(taskChanges(t, { ...form, agents })).toEqual({
      agents: {
        planning: { provider: 'claude', model: 'claude-fable-5-2' },
        dev: { provider: 'claude', options: { maxTurns: 40 } },
        qa: { provider: 'cursor' },
      },
    });
    // "Same for all" puts the development agent in every phase.
    expect(agentsFromDrafts({ ...form.agents, same: true })).toEqual({
      planning: { provider: 'claude' },
      dev: { provider: 'claude' },
      qa: { provider: 'claude' },
    });
  });

  it('recommends Fable to plan and review and Opus to develop with Claude Code', () => {
    const d = defaultDrafts([claudeInfo(true), mockInfo], null)!;
    expect(d.same).toBe(false);
    expect([d.planning.model, d.dev.model, d.qa.model]).toEqual([
      'claude-fable-5-2',
      'claude-opus-5-5',
      'claude-fable-5-2',
    ]);
    // Another first ready CLI: the same agent everywhere, its default model.
    const other = defaultDrafts([claudeInfo(false), mockInfo], null)!;
    expect(other).toEqual(sameDrafts({ provider: 'mock', model: '', mode: '' }));
  });

  it('starts from the last choice while its CLIs are ready', () => {
    const last = sameDrafts({ provider: 'mock', model: 'm', mode: '' });
    expect(defaultDrafts([claudeInfo(true), mockInfo], last)).toBe(last);
    expect(defaultDrafts([claudeInfo(true)], last)?.dev.provider).toBe('claude');
    // Its CLI logged out since: not reused.
    const claudeLast = sameDrafts({ provider: 'claude', model: '', mode: '' });
    expect(defaultDrafts([claudeInfo(false), mockInfo], claudeLast)?.dev.provider).toBe('mock');
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    saveLastDrafts(storage, last);
    expect(loadLastDrafts(storage)).toEqual(last);
    store.set('code-automata-last-agents', '{"same":1}');
    expect(loadLastDrafts(storage)).toBeNull();
    expect(loadLastDrafts(null)).toBeNull();
  });
});
