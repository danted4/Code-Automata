/**
 * Settings Page: the open project's engine settings (`.code-automata/settings.json`): checks,
 * concurrency, timeouts, rework rounds, triage on resume and the two editable prompt templates.
 * The whole `Settings` object is saved at once; the server validates it. The agent CLI files
 * (`AgentClis`) belong to the computer and apply at once.
 */

import { useEffect, useRef, useState } from 'react';
import { Loader2, Plus, RotateCcw, Save, Settings as SettingsIcon, X } from 'lucide-react';
import { toast } from 'sonner';
import { AgentClis } from '@/components/settings/agent-clis';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage } from '@/lib/api';
import type { SettingsResponse } from '@/lib/api/types/SettingsResponse';
import {
  fromForm,
  isFormDirty,
  toForm,
  validateForm,
  withChecksMode,
  type ChecksMode,
  type PrHostMode,
  type SettingsForm,
  type TimeoutKey,
} from '@/lib/settings-form';
import { useProjectStore } from '@/store/project-store';
import { useSyncStore } from '@/store/project-sync';

const pageStyle = { background: 'var(--color-background)', color: 'var(--color-text-primary)' };
const muted = { color: 'var(--color-text-muted)' };
const secondary = { color: 'var(--color-text-secondary)' };
const errorStyle = { color: 'var(--color-destructive)' };
const outlineStyle = {
  background: 'var(--color-surface)',
  borderColor: 'var(--color-border)',
  color: 'var(--color-text-primary)',
};

const CHECK_MODES: { value: ChecksMode; label: string; hint: string }[] = [
  {
    value: 'auto',
    label: 'Detect from the project',
    hint: 'package.json scripts typecheck, build and lint; tsconfig.json; Cargo.toml.',
  },
  { value: 'none', label: 'No checks', hint: 'AI review goes straight to the QA subtasks.' },
  { value: 'custom', label: 'These commands', hint: 'Run in the task worktree, in order.' },
];

const PR_HOSTS: { value: PrHostMode; label: string; hint: string }[] = [
  {
    value: 'detect',
    label: 'Detect from the remote',
    hint: 'github.com and GitHub Enterprise hosts the GitHub CLI knows use GitHub; gitlab.com and hosts named like it use GitLab; anything else is pushed only.',
  },
  { value: 'github', label: 'GitHub', hint: 'Opened with the GitHub CLI (gh).' },
  {
    value: 'gitlab',
    label: 'GitLab',
    hint: 'Opened by git itself with push options, no CLI needed. GitLab 11.10 or later, self-hosted included.',
  },
  {
    value: 'other',
    label: 'Other: push only',
    hint: 'The branch is pushed; the link your host prints for opening a pull request is kept.',
  },
];

const TIMEOUTS: { key: TimeoutKey; label: string; hint: string }[] = [
  { key: 'idle', label: 'Idle', hint: 'No agent output for this long ends a run.' },
  { key: 'tool', label: 'Tool call', hint: 'A tool call silent for this long ends a run.' },
  { key: 'total', label: 'Total', hint: 'Any single agent run longer than this is ended.' },
  { key: 'check', label: 'Check', hint: 'Any single check command longer than this fails.' },
];

const PROMPTS = [
  {
    key: 'plan',
    title: 'Plan prompt',
    placeholders: ['{{task}}', '{{answers}}'],
    testId: 'settings-prompt-plan',
  },
  {
    key: 'subtasks',
    title: 'Subtask prompt',
    placeholders: ['{{task}}', '{{plan}}'],
    testId: 'settings-prompt-subtasks',
  },
] as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      className="rounded-lg border p-5 space-y-4"
      style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
    >
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function FieldError({ message, testId }: { message?: string; testId?: string }) {
  if (!message) return null;
  return (
    <p className="text-xs" style={errorStyle} data-testid={testId}>
      {message}
    </p>
  );
}

function Notice({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div
      data-testid="settings-page"
      className="h-screen flex flex-col items-center justify-center gap-3 p-6"
      style={pageStyle}
    >
      <SettingsIcon className="w-10 h-10" style={muted} />
      <h2 className="text-xl font-semibold">{title}</h2>
      {children}
    </div>
  );
}

export default function SettingsPage() {
  const projectPath = useProjectStore((s) => s.projectPath);
  const [loaded, setLoaded] = useState<SettingsResponse | null>(null);
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const loadId = useRef(0);

  const load = () => {
    const id = ++loadId.current;
    setLoadError(null);
    api.settings
      .get()
      .then((r) => {
        if (id !== loadId.current) return;
        setLoaded(r);
        setForm(toForm(r.settings, r.promptDefaults));
        setShowErrors(false);
      })
      .catch((e) => {
        if (id === loadId.current) setLoadError(errorMessage(e));
      });
  };

  useEffect(() => {
    setLoaded(null);
    setForm(null);
    setLoadError(null);
    if (projectPath) load();
  }, [projectPath]);

  if (!projectPath) {
    return (
      <Notice title="Open a project">
        <p className="text-sm" style={secondary}>
          Settings belong to a project. Open one to edit them.
        </p>
      </Notice>
    );
  }

  if (!loaded || !form) {
    if (loadError) {
      return (
        <Notice title="Could not load settings">
          <p className="text-sm" style={secondary} data-testid="settings-load-error">
            {loadError}
          </p>
          <Button
            onClick={load}
            style={{ background: 'var(--color-primary)', color: 'var(--color-primary-text)' }}
          >
            Retry
          </Button>
        </Notice>
      );
    }
    return (
      <Notice title="Loading settings…">
        <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--color-primary)' }} />
      </Notice>
    );
  }

  const { settings, promptDefaults } = loaded;
  const errors = validateForm(form);
  const shown = showErrors ? errors : {};
  const dirty = isFormDirty(form, settings, promptDefaults);
  const update = (patch: Partial<SettingsForm>) => setForm({ ...form, ...patch });

  const save = async () => {
    const result = fromForm(form, settings, promptDefaults);
    if ('errors' in result) {
      setShowErrors(true);
      toast.error('Fix the highlighted fields first');
      return;
    }
    setSaving(true);
    try {
      const response = await api.settings.save(result.settings);
      setLoaded(response);
      setForm(toForm(response.settings, response.promptDefaults));
      setShowErrors(false);
      useSyncStore.getState().setSettings(response.settings);
      toast.success('Settings saved');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setForm(toForm(settings, promptDefaults));
    setShowErrors(false);
  };

  const setCheck = (index: number, field: 'name' | 'command', value: string) =>
    update({ checks: form.checks.map((c, i) => (i === index ? { ...c, [field]: value } : c)) });

  return (
    <div data-testid="settings-page" className="h-screen flex flex-col" style={pageStyle}>
      <header
        className="px-6 py-4 border-b flex flex-wrap items-center justify-between gap-3"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div>
          <h1 className="text-xl font-bold">Settings</h1>
          <p className="text-xs font-mono truncate max-w-[60vw]" style={muted} title={projectPath}>
            {projectPath}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {dirty && (
            <span
              className="text-sm"
              style={{ color: 'var(--color-warning)' }}
              data-testid="settings-unsaved"
            >
              Unsaved changes
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={discard}
            disabled={!dirty || saving}
            style={outlineStyle}
            data-testid="settings-discard"
          >
            Discard
          </Button>
          <Button
            size="sm"
            onClick={save}
            disabled={!dirty || saving}
            data-testid="settings-save"
            style={{ background: 'var(--color-primary)', color: 'var(--color-primary-text)' }}
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl mx-auto space-y-6">
          <Section title="Checks">
            <p className="text-sm" style={secondary}>
              Commands AI review runs before the QA subtasks. A failing check starts a rework round.
            </p>
            <RadioGroup
              value={form.checksMode}
              onValueChange={(v) => setForm(withChecksMode(form, v as ChecksMode))}
              data-testid="settings-checks-mode"
              className="gap-3"
            >
              {CHECK_MODES.map((m) => (
                <div key={m.value} className="flex items-start gap-2">
                  <RadioGroupItem
                    value={m.value}
                    id={`checks-mode-${m.value}`}
                    data-testid={`settings-checks-mode-${m.value}`}
                    className="mt-0.5"
                  />
                  <Label htmlFor={`checks-mode-${m.value}`} className="cursor-pointer space-y-0.5">
                    <span className="block text-sm font-medium">{m.label}</span>
                    <span className="block text-xs font-normal" style={muted}>
                      {m.hint}
                    </span>
                  </Label>
                </div>
              ))}
            </RadioGroup>

            {form.checksMode === 'custom' && (
              <div className="space-y-2">
                {form.checks.map((c, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2"
                    data-testid={`settings-check-row-${i}`}
                  >
                    <Input
                      value={c.name}
                      onChange={(e) => setCheck(i, 'name', e.target.value)}
                      placeholder="Name"
                      aria-label={`Check ${i + 1} name`}
                      className="w-40 shrink-0"
                      data-testid={`settings-check-name-${i}`}
                    />
                    <Input
                      value={c.command}
                      onChange={(e) => setCheck(i, 'command', e.target.value)}
                      placeholder="Command, e.g. yarn lint"
                      aria-label={`Check ${i + 1} command`}
                      className="flex-1 font-mono"
                      data-testid={`settings-check-command-${i}`}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove check ${i + 1}`}
                      title="Remove"
                      onClick={() => update({ checks: form.checks.filter((_, j) => j !== i) })}
                      data-testid={`settings-check-remove-${i}`}
                      style={secondary}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => update({ checks: [...form.checks, { name: '', command: '' }] })}
                  data-testid="settings-check-add"
                  style={outlineStyle}
                >
                  <Plus className="w-4 h-4" />
                  Add check
                </Button>
                <FieldError message={shown.checks} testId="settings-checks-error" />
              </div>
            )}
          </Section>

          <Section title="Agents">
            <div className="space-y-1.5">
              <Label htmlFor="settings-concurrency">Concurrent agents</Label>
              <Input
                id="settings-concurrency"
                inputMode="numeric"
                value={form.maxConcurrentAgents}
                onChange={(e) => update({ maxConcurrentAgents: e.target.value })}
                className="w-32"
                data-testid="settings-concurrency"
              />
              <p className="text-xs" style={muted}>
                How many agents may run at once across this project&rsquo;s tasks (default 12).
                Applies the next time the project is opened.
              </p>
              <FieldError message={shown.maxConcurrentAgents} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="settings-rework-limit">Rework rounds</Label>
              <Input
                id="settings-rework-limit"
                inputMode="numeric"
                value={form.reworkLimit}
                onChange={(e) => update({ reworkLimit: e.target.value })}
                className="w-32"
                data-testid="settings-rework-limit"
              />
              <p className="text-xs" style={muted}>
                How many times AI review may send a task back to development before it goes to Human
                Review with its findings. 0 sends it straight to Human Review.
              </p>
              <FieldError message={shown.reworkLimit} />
            </div>

            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <Label htmlFor="settings-triage">Triage on resume</Label>
                <p className="text-xs" style={muted}>
                  Before resuming an interrupted subtask that left changes, ask a read-only agent
                  whether the work is done, partial or broken.
                </p>
              </div>
              <Switch
                id="settings-triage"
                checked={form.triageOnResume}
                onCheckedChange={(checked) => update({ triageOnResume: checked })}
                data-testid="settings-triage"
              />
            </div>
          </Section>

          <Section title="Pull requests">
            <p className="text-sm" style={secondary}>
              How Create pull request opens one after pushing the task&rsquo;s branch.
            </p>
            <RadioGroup
              value={form.pullRequestHost}
              onValueChange={(v) => update({ pullRequestHost: v as PrHostMode })}
              data-testid="settings-pr-host"
              className="gap-3"
            >
              {PR_HOSTS.map((h) => (
                <div key={h.value} className="flex items-start gap-2">
                  <RadioGroupItem
                    value={h.value}
                    id={`pr-host-${h.value}`}
                    data-testid={`settings-pr-host-${h.value}`}
                    className="mt-0.5"
                  />
                  <Label htmlFor={`pr-host-${h.value}`} className="cursor-pointer space-y-0.5">
                    <span className="block text-sm font-medium">{h.label}</span>
                    <span className="block text-xs font-normal" style={muted}>
                      {h.hint}
                    </span>
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </Section>

          <Section title="Agent CLIs on this computer">
            <p className="text-sm" style={secondary}>
              Where each agent's command-line tool is. The app looks in each tool's install folder,
              then on your shell's PATH; choose a file here if it finds the wrong one or none.
              Applies to every project at once; no Save needed.
            </p>
            <AgentClis />
          </Section>

          <Section title="Timeouts">
            <p className="text-sm" style={secondary}>
              In minutes; fractions are allowed (0.5 is 30 seconds). At most 24 hours.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              {TIMEOUTS.map((t) => (
                <div key={t.key} className="space-y-1.5">
                  <Label htmlFor={`settings-timeout-${t.key}`}>{t.label}</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id={`settings-timeout-${t.key}`}
                      inputMode="decimal"
                      value={form.timeouts[t.key]}
                      onChange={(e) =>
                        update({ timeouts: { ...form.timeouts, [t.key]: e.target.value } })
                      }
                      className="w-28"
                      data-testid={`settings-timeout-${t.key}`}
                    />
                    <span className="text-sm" style={muted}>
                      min
                    </span>
                  </div>
                  <p className="text-xs" style={muted}>
                    {t.hint}
                  </p>
                  <FieldError message={shown.timeouts?.[t.key]} />
                </div>
              ))}
            </div>
          </Section>

          <Section title="Prompt templates">
            <p className="text-sm" style={secondary}>
              These replace the editable part of two prompts. Code-Automata always appends its own
              output instructions, so a custom template cannot break parsing.
            </p>
            {PROMPTS.map((p) => {
              const value = form.prompts[p.key];
              const isDefault = value === promptDefaults[p.key];
              const error = p.key === 'plan' ? shown.promptPlan : shown.promptSubtasks;
              return (
                <div key={p.key} className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor={p.testId} className="text-base font-medium">
                      {p.title}
                    </Label>
                    <span className="text-xs" style={muted} data-testid={`${p.testId}-state`}>
                      {isDefault ? 'Default' : 'Custom'}
                    </span>
                  </div>
                  <p className="text-xs" style={muted}>
                    Placeholders: {p.placeholders.join(', ')}
                  </p>
                  <Textarea
                    id={p.testId}
                    value={value}
                    onChange={(e) =>
                      update({ prompts: { ...form.prompts, [p.key]: e.target.value } })
                    }
                    rows={14}
                    className="font-mono text-sm"
                    data-testid={p.testId}
                  />
                  <FieldError message={error} />
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() =>
                      update({ prompts: { ...form.prompts, [p.key]: promptDefaults[p.key] } })
                    }
                    disabled={isDefault}
                    data-testid={`${p.testId}-reset`}
                    style={outlineStyle}
                  >
                    <RotateCcw className="w-4 h-4" />
                    Reset to default
                  </Button>
                </div>
              );
            })}
          </Section>
        </div>
      </div>
    </div>
  );
}
