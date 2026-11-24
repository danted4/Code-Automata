import { describe, expect, it } from 'vitest';
import type { Preflight } from '@/lib/api/types/Preflight';
import type { ProviderInfo } from '@/lib/api/types/ProviderInfo';
import type { Run } from '@/lib/api/types/Run';
import type { Task } from '@/lib/api/types/Task';
import {
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
    agent: { provider: 'claude' },
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
    const t = task({ agent: { provider: 'amp', mode: 'low', options: { a: 1 } } });
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
      taskChanges(t, { ...form, agent: { provider: 'claude', model: 'opus', mode: '' } })
    ).toEqual({ agent: { provider: 'claude', model: 'opus' } });
  });

  it('leaves the agent out while a run holds it', () => {
    const t = task({ run });
    const form = formFromTask(t);
    expect(taskChanges(t, { ...form, agent: { provider: 'amp', model: '', mode: '' } })).toEqual(
      {}
    );
  });
});

describe('agentLockedReason', () => {
  it('is null without a run and says why with one', () => {
    expect(agentLockedReason(null)).toBeNull();
    expect(agentLockedReason(run)).toMatch(/cannot change/);
    expect(agentLockedReason({ ...run, state: 'failed' })).toMatch(/cannot change/);
  });
});
