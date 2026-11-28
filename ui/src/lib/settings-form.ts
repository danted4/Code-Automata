/**
 * The settings page's form state and its conversion to and from `Settings`.
 *
 * Numbers are kept as the text the user typed so a half-typed value is not lost; `fromForm`
 * parses and validates them. The server validates again and has the last word.
 */

import type { CheckCommand } from '@/lib/api/types/CheckCommand';
import type { McpServer } from '@/lib/api/types/McpServer';
import type { MemoryView } from '@/lib/api/types/MemoryView';
import type { PrHost } from '@/lib/api/types/PrHost';
import type { PromptDefaults } from '@/lib/api/types/PromptDefaults';
import type { PromptOverrides } from '@/lib/api/types/PromptOverrides';
import type { RepoChecks } from '@/lib/api/types/RepoChecks';
import type { Settings } from '@/lib/api/types/Settings';

/** `auto`: detect from the project (`checks` null); `none`: `[]`; `custom`: the list. */
export type ChecksMode = 'auto' | 'none' | 'custom';

/** `detect`: from the `origin` remote (`pullRequestHost` left out). */
export type PrHostMode = 'detect' | PrHost;

export const TIMEOUT_KEYS = ['idle', 'tool', 'total', 'check'] as const;
export type TimeoutKey = (typeof TIMEOUT_KEYS)[number];

/**
 * One MCP server as the form edits it: arguments one per line, variables as `NAME=value` lines,
 * headers as `Name: value` lines.
 */
export type McpRow = {
  name: string;
  type: 'stdio' | 'http';
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
  /**
   * The saved server this row was made from, and the row as made: while the row is unchanged the
   * saved server is kept exactly (text rows lose an empty argument or one with a line break).
   */
  saved?: { server: McpServer; row: string };
};

export const EMPTY_MCP_ROW: McpRow = {
  name: '',
  type: 'stdio',
  command: '',
  args: '',
  env: '',
  url: '',
  headers: '',
};

/** A workspace repository's own checks and pull request host. */
export type RepoForm = {
  checksMode: ChecksMode;
  checks: CheckCommand[];
  pullRequestHost: PrHostMode;
};

export type SettingsForm = {
  checksMode: ChecksMode;
  /** Kept while another mode is selected, so switching back does not lose the list. */
  checks: CheckCommand[];
  maxConcurrentAgents: string;
  timeouts: Record<TimeoutKey, string>;
  reworkLimit: string;
  triageOnResume: boolean;
  prompts: { plan: string; subtasks: string };
  pullRequestHost: PrHostMode;
  /** A workspace's repositories, by name in name order; empty for a one-repository project. */
  repos: Record<string, RepoForm>;
  /** The MCP servers agents may use, in name order. */
  mcp: McpRow[];
  useProjectMemory: boolean;
};

export type FormErrors = Partial<{
  checks: string;
  maxConcurrentAgents: string;
  reworkLimit: string;
  promptPlan: string;
  promptSubtasks: string;
}> & {
  timeouts?: Partial<Record<TimeoutKey, string>>;
  /** Per workspace repository, the checks error. */
  repoChecks?: Record<string, string>;
  /** Per MCP row (by index), what is wrong with it. */
  mcp?: Record<number, string>;
};

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

/**
 * `repoNames` are the workspace's repositories now; ones only the settings name (a folder since
 * removed) are kept too, so saving does not drop them.
 */
export function toForm(
  settings: Settings,
  defaults: PromptDefaults,
  repoNames: string[] = []
): SettingsForm {
  const t = settings.timeouts;
  const names = [...new Set([...repoNames, ...Object.keys(settings.repos ?? {})])]
    .filter((n) => n !== '.')
    .sort();
  const repos: Record<string, RepoForm> = {};
  for (const name of names) {
    const own = settings.repos?.[name];
    repos[name] = {
      checksMode: checksMode(own?.checks),
      checks: (own?.checks ?? []).map((c) => ({ name: c.name, command: c.command })),
      pullRequestHost: own?.pullRequestHost ?? 'detect',
    };
  }
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
    pullRequestHost: settings.pullRequestHost ?? 'detect',
    repos,
    mcp: Object.entries(settings.mcpServers ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, server]) => mcpRow(name, server)),
    useProjectMemory: settings.useProjectMemory ?? true,
  };
}

/** The fields of a row the user edits, for telling an untouched row. */
function rowText(row: McpRow): string {
  const { saved: _saved, ...fields } = row;
  return JSON.stringify(fields);
}

/** A server as a form row, keeping the server for as long as the row is not edited. */
export function mcpRow(name: string, server: McpServer): McpRow {
  const row = textRow(name, server);
  return { ...row, saved: { server, row: rowText(row) } };
}

function textRow(name: string, server: McpServer): McpRow {
  if (server.type === 'stdio') {
    return {
      ...EMPTY_MCP_ROW,
      name,
      command: server.command,
      args: (server.args ?? []).join('\n'),
      env: Object.entries(server.env ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
    };
  }
  return {
    ...EMPTY_MCP_ROW,
    name,
    type: 'http',
    url: server.url,
    headers: Object.entries(server.headers ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n'),
  };
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

type Pairs = { ok: true; map: Record<string, string> } | { ok: false; line: string };

/** `KEY<sep>value` lines as a map, or the first line that is not one. */
function pairs(text: string, sep: string): Pairs {
  const map: Record<string, string> = {};
  for (const line of lines(text)) {
    const i = line.indexOf(sep);
    if (i <= 0) return { ok: false, line };
    map[line.slice(0, i).trim()] = line.slice(i + sep.length).trim();
  }
  return { ok: true, map };
}

/** The server a row stands for, or what is wrong with it. */
export function mcpServer(row: McpRow): { server: McpServer } | { error: string } {
  if (row.saved && rowText(row) === row.saved.row) return { server: row.saved.server };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(row.name.trim())) {
    return { error: 'A name of letters, digits, "-" and "_".' };
  }
  if (row.type === 'stdio') {
    if (!row.command.trim()) return { error: 'A command is needed.' };
    const env = pairs(row.env, '=');
    if (!env.ok) return { error: `Not NAME=value: ${env.line}` };
    const server: McpServer = { type: 'stdio', command: row.command.trim() };
    const args = lines(row.args);
    if (args.length) server.args = args;
    if (Object.keys(env.map).length) server.env = env.map;
    return { server };
  }
  if (!row.url.trim()) return { error: 'An address is needed.' };
  const headers = pairs(row.headers, ':');
  if (!headers.ok) return { error: `Not "Name: value": ${headers.line}` };
  const server: McpServer = { type: 'http', url: row.url.trim() };
  if (Object.keys(headers.map).length) server.headers = headers.map;
  return { server };
}

/** Switch the checks mode; choosing `custom` with an empty list starts one blank row. */
export function withChecksMode<T extends { checksMode: ChecksMode; checks: CheckCommand[] }>(
  form: T,
  mode: ChecksMode
): T {
  const checks =
    mode === 'custom' && form.checks.length === 0 ? [{ name: '', command: '' }] : form.checks;
  return { ...form, checksMode: mode, checks };
}

function checksError(mode: ChecksMode, checks: CheckCommand[]): string | null {
  if (mode !== 'custom') return null;
  if (checks.length === 0) return 'Add a check, or choose "No checks".';
  if (checks.some((c) => !c.name.trim() || !c.command.trim())) {
    return 'Every check needs a name and a command.';
  }
  return null;
}

function checksValue(mode: ChecksMode, checks: CheckCommand[]): CheckCommand[] | undefined {
  if (mode === 'none') return [];
  if (mode === 'custom')
    return checks.map((c) => ({ name: c.name.trim(), command: c.command.trim() }));
  return undefined;
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
  const checks = checksError(form.checksMode, form.checks);
  if (checks) errors.checks = checks;
  for (const [name, repo] of Object.entries(form.repos)) {
    const message = checksError(repo.checksMode, repo.checks);
    if (message) errors.repoChecks = { ...errors.repoChecks, [name]: message };
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
  const names = new Set<string>();
  form.mcp.forEach((row, i) => {
    const result = mcpServer(row);
    const name = row.name.trim();
    const message =
      'error' in result ? result.error : names.has(name) ? 'Two servers have this name.' : null;
    names.add(name);
    if (message) errors.mcp = { ...errors.mcp, [i]: message };
  });
  if (!form.prompts.plan.trim()) errors.promptPlan = 'Empty. Use "Reset to default" instead.';
  if (!form.prompts.subtasks.trim()) {
    errors.promptSubtasks = 'Empty. Use "Reset to default" instead.';
  }
  return errors;
}

export function hasErrors(errors: FormErrors): boolean {
  const { timeouts, repoChecks, mcp, ...rest } = errors;
  return (
    Object.keys(rest).length > 0 ||
    Object.keys(timeouts ?? {}).length > 0 ||
    Object.keys(repoChecks ?? {}).length > 0 ||
    Object.keys(mcp ?? {}).length > 0
  );
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
    useProjectMemory: form.useProjectMemory,
  };
  const checks = checksValue(form.checksMode, form.checks);
  if (checks) settings.checks = checks;
  // Only repositories with something set; in name order, so equal settings compare equal.
  const repos: NonNullable<Settings['repos']> = {};
  for (const name of Object.keys(form.repos).sort()) {
    const repo = form.repos[name];
    const own: NonNullable<Settings['repos']>[string] = {};
    const repoChecks = checksValue(repo.checksMode, repo.checks);
    if (repoChecks) own.checks = repoChecks;
    if (repo.pullRequestHost !== 'detect') own.pullRequestHost = repo.pullRequestHost;
    if (Object.keys(own).length > 0) repos[name] = own;
  }
  if (Object.keys(repos).length > 0) settings.repos = repos;
  if (Object.keys(prompts).length > 0) settings.prompts = prompts;
  if (form.pullRequestHost !== 'detect') settings.pullRequestHost = form.pullRequestHost;
  const mcp: Record<string, McpServer> = {};
  for (const row of [...form.mcp].sort((a, b) => a.name.trim().localeCompare(b.name.trim()))) {
    const result = mcpServer(row);
    if ('server' in result) mcp[row.name.trim()] = result.server;
  }
  if (Object.keys(mcp).length > 0) settings.mcpServers = mcp;
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
  const loadedForm = toForm(loaded, defaults, Object.keys(form.repos));
  const now = fromForm(form, loaded, defaults);
  const then = fromForm(loadedForm, loaded, defaults);
  if ('errors' in now || 'errors' in then) {
    return JSON.stringify(form) !== JSON.stringify(loadedForm);
  }
  return JSON.stringify(now.settings) !== JSON.stringify(then.settings);
}

/** Where the commands a task would run now come from, in words. */
export function checkSourceText(info: RepoChecks | undefined): string {
  if (!info) return 'Not in the workspace now.';
  const list = info.commands.map((c) => c.command).join(', ') || 'none';
  switch (info.source) {
    case 'workspace':
      return `Now: ${list} (these settings)`;
    case 'repo':
      return `Now: ${list} (the repository's own settings)`;
    case 'project':
      return `Now: ${list}`;
    case 'detected':
      return info.commands.length ? `Now: ${list} (detected)` : 'Now: none detected';
  }
}

/** The line under the memory editor: its size, and whether prompts get only part of it. */
export function memoryNote(view: MemoryView): string {
  if (view.bytes === 0) return 'Empty.';
  const size = view.bytes < 1024 ? `${view.bytes} bytes` : `${(view.bytes / 1024).toFixed(1)} KB`;
  return view.truncated
    ? `${size}. Memory is full: prompts get only the newest entries; prune it.`
    : `${size}. Every prompt gets all of it.`;
}
