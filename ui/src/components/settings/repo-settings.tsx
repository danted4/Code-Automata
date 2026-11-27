/**
 * A workspace repository's own settings on the Settings page: its checks (with what a task would
 * run now, and where that comes from) and how its pull requests are opened.
 */

import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { RepoChecks } from '@/lib/api/types/RepoChecks';
import {
  checkSourceText,
  withChecksMode,
  type ChecksMode,
  type PrHostMode,
  type RepoForm,
} from '@/lib/settings-form';

const muted = { color: 'var(--color-text-muted)' };
const secondary = { color: 'var(--color-text-secondary)' };

const MODES: { value: ChecksMode; label: string }[] = [
  { value: 'auto', label: 'Its own settings, else detected' },
  { value: 'none', label: 'No checks' },
  { value: 'custom', label: 'These commands' },
];

const HOSTS: { value: PrHostMode; label: string }[] = [
  { value: 'detect', label: 'Detect from its remote' },
  { value: 'github', label: 'GitHub' },
  { value: 'gitlab', label: 'GitLab' },
  { value: 'other', label: 'Other: push only' },
];

export function RepoSettings({
  name,
  form,
  info,
  error,
  onChange,
}: {
  name: string;
  form: RepoForm;
  info: RepoChecks | undefined;
  error?: string;
  onChange: (next: RepoForm) => void;
}) {
  const setCheck = (index: number, field: 'name' | 'command', value: string) =>
    onChange({
      ...form,
      checks: form.checks.map((c, i) => (i === index ? { ...c, [field]: value } : c)),
    });
  return (
    <div
      className="rounded-md border p-3 space-y-2"
      style={{ borderColor: 'var(--color-border)' }}
      data-testid={`settings-repo-${name}`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono font-semibold text-sm">{name}/</span>
        <span className="text-xs" style={muted} data-testid={`settings-repo-source-${name}`}>
          {checkSourceText(info)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs w-24" style={secondary}>
          Checks
        </span>
        <Select
          value={form.checksMode}
          onValueChange={(v) => onChange(withChecksMode(form, v as ChecksMode))}
        >
          <SelectTrigger
            className="w-[240px] h-8 text-xs"
            data-testid={`settings-repo-checks-${name}`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODES.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {form.checksMode === 'custom' && (
        <div className="space-y-2 pl-0 sm:pl-[108px]">
          {form.checks.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={c.name}
                onChange={(e) => setCheck(i, 'name', e.target.value)}
                placeholder="Name"
                aria-label={`${name} check ${i + 1} name`}
                className="w-32 shrink-0 h-8 text-xs"
              />
              <Input
                value={c.command}
                onChange={(e) => setCheck(i, 'command', e.target.value)}
                placeholder="Command, run in its worktree"
                aria-label={`${name} check ${i + 1} command`}
                className="flex-1 font-mono h-8 text-xs"
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove ${name} check ${i + 1}`}
                onClick={() => onChange({ ...form, checks: form.checks.filter((_, j) => j !== i) })}
                style={secondary}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 h-7 text-xs"
            onClick={() =>
              onChange({ ...form, checks: [...form.checks, { name: '', command: '' }] })
            }
          >
            <Plus className="w-3.5 h-3.5" />
            Add check
          </Button>
          {error && (
            <p className="text-xs" style={{ color: 'var(--color-destructive)' }}>
              {error}
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs w-24" style={secondary}>
          Pull requests
        </span>
        <Select
          value={form.pullRequestHost}
          onValueChange={(v) => onChange({ ...form, pullRequestHost: v as PrHostMode })}
        >
          <SelectTrigger
            className="w-[240px] h-8 text-xs"
            data-testid={`settings-repo-host-${name}`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {HOSTS.map((h) => (
              <SelectItem key={h.value} value={h.value}>
                {h.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
