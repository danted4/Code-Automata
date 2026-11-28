import { describe, expect, it } from 'vitest';
import type { PromptDefaults } from '@/lib/api/types/PromptDefaults';
import type { RepoChecks } from '@/lib/api/types/RepoChecks';
import type { Settings } from '@/lib/api/types/Settings';
import {
  checkSourceText,
  checksMode,
  fromForm,
  hasErrors,
  isFormDirty,
  toForm,
  validateForm,
  withChecksMode,
} from './settings-form';

const defaults: PromptDefaults = { plan: 'PLAN {{task}}', subtasks: 'SUBTASKS {{plan}}' };

function settings(over: Partial<Settings> = {}): Settings {
  return {
    schema: 1,
    maxConcurrentAgents: 12,
    timeouts: { idleMinutes: 10, toolMinutes: 30, totalMinutes: 120, checkMinutes: 10 },
    reworkLimit: 2,
    triageOnResume: false,
    ...over,
  };
}

function save(s: Settings, edit: (f: ReturnType<typeof toForm>) => void = () => {}) {
  const form = toForm(s, defaults);
  edit(form);
  return fromForm(form, s, defaults);
}

describe('checks mode', () => {
  it('maps null, [] and a list', () => {
    expect(checksMode(null)).toBe('auto');
    expect(checksMode(undefined)).toBe('auto');
    expect(checksMode([])).toBe('none');
    expect(checksMode([{ name: 'lint', command: 'yarn lint' }])).toBe('custom');
  });

  it('round-trips each mode', () => {
    expect(save(settings())).toEqual({ settings: settings() });
    expect(save(settings({ checks: [] }))).toEqual({ settings: settings({ checks: [] }) });
    const list = [{ name: 'lint', command: 'yarn lint' }];
    expect(save(settings({ checks: list }))).toEqual({ settings: settings({ checks: list }) });
  });

  it('starts a blank row when switching to custom with no list, and keeps a list across modes', () => {
    const form = withChecksMode(toForm(settings(), defaults), 'custom');
    expect(form.checks).toEqual([{ name: '', command: '' }]);
    expect(validateForm(form).checks).toBe('Every check needs a name and a command.');

    const custom = toForm(settings({ checks: [{ name: 'a', command: 'b' }] }), defaults);
    const back = withChecksMode(withChecksMode(custom, 'auto'), 'custom');
    expect(back.checks).toEqual([{ name: 'a', command: 'b' }]);
  });

  it('refuses an empty custom list and sends none for auto', () => {
    const form = { ...toForm(settings(), defaults), checksMode: 'custom' as const };
    expect(validateForm(form).checks).toMatch(/No checks/);
    const r = save(settings({ checks: [{ name: 'a', command: 'b' }] }), (f) => {
      f.checksMode = 'auto';
    });
    expect('settings' in r && 'checks' in r.settings).toBe(false);
  });

  it('trims names and commands', () => {
    const r = save(settings({ checks: [{ name: 'a', command: 'b' }] }), (f) => {
      f.checks = [{ name: ' lint ', command: ' yarn lint ' }];
    });
    expect(r).toEqual({ settings: settings({ checks: [{ name: 'lint', command: 'yarn lint' }] }) });
  });
});

describe('numbers', () => {
  it('requires a positive whole concurrency', () => {
    for (const bad of ['0', '-1', '1.5', '', 'x']) {
      const form = { ...toForm(settings(), defaults), maxConcurrentAgents: bad };
      expect(validateForm(form).maxConcurrentAgents).toBeDefined();
    }
    const r = save(settings(), (f) => (f.maxConcurrentAgents = ' 4 '));
    expect('settings' in r && r.settings.maxConcurrentAgents).toBe(4);
  });

  it('allows a rework limit of 0', () => {
    const r = save(settings(), (f) => (f.reworkLimit = '0'));
    expect('settings' in r && r.settings.reworkLimit).toBe(0);
    const form = { ...toForm(settings(), defaults), reworkLimit: '-1' };
    expect(validateForm(form).reworkLimit).toBeDefined();
  });

  it('accepts fractional timeouts within the server bounds', () => {
    const r = save(settings(), (f) => (f.timeouts.idle = '0.5'));
    expect('settings' in r && r.settings.timeouts.idleMinutes).toBe(0.5);
    const dot = save(settings(), (f) => (f.timeouts.idle = '.5'));
    expect('settings' in dot && dot.settings.timeouts.idleMinutes).toBe(0.5);
    for (const bad of ['0', '-2', '1441', '', 'abc', 'Infinity', '0x10', '1e2', '1.2.3']) {
      const form = toForm(settings(), defaults);
      form.timeouts.check = bad;
      const errors = validateForm(form);
      expect(errors.timeouts?.check).toBeDefined();
      expect(hasErrors(errors)).toBe(true);
    }
  });
});

describe('prompts', () => {
  it('prefills overrides, or the defaults when unset', () => {
    expect(toForm(settings(), defaults).prompts).toEqual(defaults);
    const form = toForm(settings({ prompts: { plan: 'MINE' } }), defaults);
    expect(form.prompts).toEqual({ plan: 'MINE', subtasks: defaults.subtasks });
  });

  it('omits a prompt equal to its default', () => {
    const r = save(
      settings({ prompts: { plan: 'MINE' } }),
      (f) => (f.prompts.plan = defaults.plan)
    );
    expect(r).toEqual({ settings: settings() });
  });

  it('saves the pull request host only when it is not detected', () => {
    expect(toForm(settings(), defaults).pullRequestHost).toBe('detect');
    expect(save(settings(), (f) => (f.pullRequestHost = 'gitlab'))).toEqual({
      settings: settings({ pullRequestHost: 'gitlab' }),
    });
    const set = settings({ pullRequestHost: 'other' });
    expect(save(set)).toEqual({ settings: set });
    expect(save(set, (f) => (f.pullRequestHost = 'detect'))).toEqual({ settings: settings() });
  });

  it('keeps an edited prompt', () => {
    const r = save(settings(), (f) => (f.prompts.subtasks = 'Custom'));
    expect(r).toEqual({ settings: settings({ prompts: { subtasks: 'Custom' } }) });
  });

  it('refuses an empty prompt', () => {
    const form = toForm(settings(), defaults);
    form.prompts.plan = '  ';
    expect(validateForm(form).promptPlan).toBeDefined();
  });
});

describe('schema and dirty state', () => {
  it('keeps the loaded schema', () => {
    const r = save(settings({ schema: 7 }));
    expect('settings' in r && r.settings.schema).toBe(7);
  });

  it('is clean when unchanged or retyped, dirty when changed', () => {
    const s = settings();
    const form = toForm(s, defaults);
    expect(isFormDirty(form, s, defaults)).toBe(false);
    expect(isFormDirty({ ...form, maxConcurrentAgents: '12 ' }, s, defaults)).toBe(false);
    expect(isFormDirty({ ...form, triageOnResume: true }, s, defaults)).toBe(true);
    expect(isFormDirty({ ...form, reworkLimit: '' }, s, defaults)).toBe(true);
    expect(isFormDirty(withChecksMode(form, 'none'), s, defaults)).toBe(true);
  });
});

describe('workspace repositories', () => {
  const defaults = { plan: 'P', subtasks: 'S' };
  const base: Settings = {
    schema: 1,
    maxConcurrentAgents: 12,
    timeouts: { idleMinutes: 10, toolMinutes: 30, totalMinutes: 120, checkMinutes: 10 },
    reworkLimit: 2,
    triageOnResume: false,
    repos: {
      web: { checks: [{ name: 'lint', command: 'yarn lint' }] },
      gone: { pullRequestHost: 'gitlab' },
    },
  };

  it('has a row per repository, keeping one the settings name that is gone', () => {
    const form = toForm(base, defaults, ['api', 'web']);
    expect(Object.keys(form.repos)).toEqual(['api', 'gone', 'web']);
    expect(form.repos.api).toEqual({ checksMode: 'auto', checks: [], pullRequestHost: 'detect' });
    expect(form.repos.web.checksMode).toBe('custom');
    expect(form.repos.gone.pullRequestHost).toBe('gitlab');
    expect(isFormDirty(form, base, defaults)).toBe(false);
  });

  it('saves only repositories with something set', () => {
    const form = toForm(base, defaults, ['api', 'web']);
    form.repos.api = { ...form.repos.api, checksMode: 'none', pullRequestHost: 'github' };
    form.repos.web = { ...form.repos.web, checksMode: 'auto' };
    expect(isFormDirty(form, base, defaults)).toBe(true);
    const out = fromForm(form, base, defaults);
    expect('settings' in out && out.settings.repos).toEqual({
      api: { checks: [], pullRequestHost: 'github' },
      gone: { pullRequestHost: 'gitlab' },
    });
  });

  it('names the repository whose checks are incomplete', () => {
    const form = toForm(base, defaults, ['api', 'web']);
    form.repos.api = {
      checksMode: 'custom',
      checks: [{ name: '', command: 'x' }],
      pullRequestHost: 'detect',
    };
    const out = fromForm(form, base, defaults);
    expect('errors' in out && out.errors.repoChecks).toEqual({
      api: 'Every check needs a name and a command.',
    });
  });
});

describe('checkSourceText', () => {
  it('says where the commands come from', () => {
    const c = (source: RepoChecks['source'], commands: string[]): RepoChecks => ({
      repo: 'api',
      source,
      commands: commands.map((command) => ({ name: command, command })),
    });
    expect(checkSourceText(c('detected', ['yarn lint']))).toBe('Now: yarn lint (detected)');
    expect(checkSourceText(c('detected', []))).toBe('Now: none detected');
    expect(checkSourceText(c('repo', ['make test']))).toBe(
      "Now: make test (the repository's own settings)"
    );
    expect(checkSourceText(c('workspace', []))).toBe('Now: none (these settings)');
    expect(checkSourceText(undefined)).toBe('Not in the workspace now.');
  });
});

describe('MCP servers', () => {
  it('are kept as they are when the form saves', () => {
    const mcpServers = { docs: { type: 'http' as const, url: 'https://d/mcp' } };
    const saved = save(settings({ mcpServers }), (f) => {
      f.reworkLimit = '3';
    });
    expect('settings' in saved && saved.settings.mcpServers).toEqual(mcpServers);
  });
});
