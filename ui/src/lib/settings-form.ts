/**
 * The settings page's form state and its conversion to and from `Settings`.
 *
 * Numbers are kept as the text the user typed so a half-typed value is not lost; `fromForm`
 * parses and validates them. The server validates again and has the last word.
 */

import type { CheckCommand } from '@/lib/api/types/CheckCommand';
import type { PromptDefaults } from '@/lib/api/types/PromptDefaults';
import type { PromptOverrides } from '@/lib/api/types/PromptOverrides';
import type { Settings } from '@/lib/api/types/Settings';

/** `auto`: detect from the project (`checks` null); `none`: `[]`; `custom`: the list. */
export type ChecksMode = 'auto' | 'none' | 'custom';

export const TIMEOUT_KEYS = ['idle', 'tool', 'total', 'check'] as const;
export type TimeoutKey = (typeof TIMEOUT_KEYS)[number];

export type SettingsForm = {
  checksMode: ChecksMode;
  /** Kept while another mode is selected, so switching back does not lose the list. */
  checks: CheckCommand[];
  maxConcurrentAgents: string;
  timeouts: Record<TimeoutKey, string>;
  reworkLimit: string;
  triageOnResume: boolean;
  prompts: { plan: string; subtasks: string };
};

export type FormErrors = Partial<{
  checks: string;
  maxConcurrentAgents: string;
  reworkLimit: string;
  promptPlan: string;
  promptSubtasks: string;
}> & { timeouts?: Partial<Record<TimeoutKey, string>> };

export const DEFAULT_MAX_CONCURRENT_AGENTS = 12;
/** The server's upper bound for a timeout. */
export const MAX_TIMEOUT_MINUTES = 24 * 60;
const U32_MAX = 4294967295;

const timeoutField = {
  idle: 'idleMinutes',
  tool: 'toolMinutes',
  total: 'totalMinutes',
  check: 'checkMinutes',
} as const satisfies Record<TimeoutKey, keyof Settings['timeouts']>;

export function checksMode(checks: Settings['checks']): ChecksMode {
  if (checks == null) return 'auto';
  return checks.length === 0 ? 'none' : 'custom';
}

export function toForm(settings: Settings, defaults: PromptDefaults): SettingsForm {
  const t = settings.timeouts;
  return {
    checksMode: checksMode(settings.checks),
    checks: (settings.checks ?? []).map((c) => ({ name: c.name, command: c.command })),
    maxConcurrentAgents: String(settings.maxConcurrentAgents),
    timeouts: {
      idle: String(t.idleMinutes),
      tool: String(t.toolMinutes),
      total: String(t.totalMinutes),
      check: String(t.checkMinutes),
    },
    reworkLimit: String(settings.reworkLimit),
    triageOnResume: settings.triageOnResume,
    prompts: {
      plan: settings.prompts?.plan ?? defaults.plan,
      subtasks: settings.prompts?.subtasks ?? defaults.subtasks,
    },
  };
}

/** Switch the checks mode; choosing `custom` with an empty list starts one blank row. */
export function withChecksMode(form: SettingsForm, mode: ChecksMode): SettingsForm {
  const checks =
    mode === 'custom' && form.checks.length === 0 ? [{ name: '', command: '' }] : form.checks;
  return { ...form, checksMode: mode, checks };
}

function parseCount(text: string, min: number): number | null {
  const s = text.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= U32_MAX ? n : null;
}

function parseMinutes(text: string): number | null {
  const s = text.trim();
  // Plain decimals only: Number() would also take "0x10" and "1e2".
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 && n <= MAX_TIMEOUT_MINUTES ? n : null;
}

/** Field errors for the form; empty when it can be saved. */
export function validateForm(form: SettingsForm): FormErrors {
  const errors: FormErrors = {};
  if (form.checksMode === 'custom') {
    if (form.checks.length === 0) {
      errors.checks = 'Add a check, or choose "No checks".';
    } else if (form.checks.some((c) => !c.name.trim() || !c.command.trim())) {
      errors.checks = 'Every check needs a name and a command.';
    }
  }
  if (parseCount(form.maxConcurrentAgents, 1) === null) {
    errors.maxConcurrentAgents = 'A whole number, 1 or more.';
  }
  if (parseCount(form.reworkLimit, 0) === null) {
    errors.reworkLimit = 'A whole number, 0 or more.';
  }
  for (const key of TIMEOUT_KEYS) {
    if (parseMinutes(form.timeouts[key]) === null) {
      errors.timeouts = {
        ...errors.timeouts,
        [key]: `More than 0 and at most ${MAX_TIMEOUT_MINUTES} minutes.`,
      };
    }
  }
  if (!form.prompts.plan.trim()) errors.promptPlan = 'Empty. Use "Reset to default" instead.';
  if (!form.prompts.subtasks.trim()) {
    errors.promptSubtasks = 'Empty. Use "Reset to default" instead.';
  }
  return errors;
}

export function hasErrors(errors: FormErrors): boolean {
  const { timeouts, ...rest } = errors;
  return Object.keys(rest).length > 0 || Object.keys(timeouts ?? {}).length > 0;
}

/**
 * The `Settings` to save, or the errors. `base` is the loaded settings: its `schema` is kept as
 * is. A prompt equal to its default is not sent, so the default keeps applying if it changes.
 */
export function fromForm(
  form: SettingsForm,
  base: Settings,
  defaults: PromptDefaults
): { settings: Settings } | { errors: FormErrors } {
  const errors = validateForm(form);
  if (hasErrors(errors)) return { errors };

  const timeouts = {} as Settings['timeouts'];
  for (const key of TIMEOUT_KEYS) timeouts[timeoutField[key]] = Number(form.timeouts[key].trim());

  const prompts: PromptOverrides = {};
  if (form.prompts.plan !== defaults.plan) prompts.plan = form.prompts.plan;
  if (form.prompts.subtasks !== defaults.subtasks) prompts.subtasks = form.prompts.subtasks;

  const settings: Settings = {
    schema: base.schema,
    maxConcurrentAgents: Number(form.maxConcurrentAgents.trim()),
    timeouts,
    reworkLimit: Number(form.reworkLimit.trim()),
    triageOnResume: form.triageOnResume,
  };
  if (form.checksMode === 'none') settings.checks = [];
  if (form.checksMode === 'custom') {
    settings.checks = form.checks.map((c) => ({ name: c.name.trim(), command: c.command.trim() }));
  }
  if (Object.keys(prompts).length > 0) settings.prompts = prompts;
  return { settings };
}

/**
 * Whether the form would save something other than what was loaded. Compares what would be sent,
 * so retyping a value or switching a mode back and forth does not count; an invalid form counts
 * as changed when its text differs from the loaded form.
 */
export function isFormDirty(
  form: SettingsForm,
  loaded: Settings,
  defaults: PromptDefaults
): boolean {
  const now = fromForm(form, loaded, defaults);
  const then = fromForm(toForm(loaded, defaults), loaded, defaults);
  if ('errors' in now || 'errors' in then) {
    return JSON.stringify(form) !== JSON.stringify(toForm(loaded, defaults));
  }
  return JSON.stringify(now.settings) !== JSON.stringify(then.settings);
}
