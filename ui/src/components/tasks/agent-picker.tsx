/**
 * Agent picker shared by the new-task and edit-task modals: the providers the server offers, in
 * its order, each with its readiness, plus optional model and mode.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { api, errorMessage } from '@/lib/api';
import type { Preflight } from '@/lib/api/types/Preflight';
import type { Provider } from '@/lib/api/types/Provider';
import type { ProviderInfo } from '@/lib/api/types/ProviderInfo';
import {
  AGENT_PHASES,
  AGENT_PHASE_LABELS,
  type AgentDraft,
  type AgentPhase,
  type PhaseDrafts,
  readiness,
  sameDrafts,
  suggestedMode,
  takesMode,
} from '@/lib/agent-form';
import type { ModelList } from '@/lib/api/types/ModelList';
import { Checkbox } from '@/components/ui/checkbox';
import { offerCliChoice, sourceText } from '@/lib/cli-path';
import { CliPathChooser } from './cli-path-chooser';

export type ProvidersState = {
  /** Null while loading. */
  providers: ProviderInfo[] | null;
  error: string | null;
  retry: () => void;
  /** Put one provider's fresh check in place (after its CLI file was chosen). */
  replace: (info: ProviderInfo) => void;
};

/** The server's providers with their preflight, fetched when the calling component mounts. */
export function useProviders(): ProvidersState {
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .providers()
      .then((list) => {
        if (!cancelled) setProviders(list);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return {
    providers,
    error,
    retry: () => {
      setProviders(null);
      setError(null);
      setAttempt((a) => a + 1);
    },
    replace: (info) =>
      setProviders((list) => list?.map((p) => (p.provider === info.provider ? info : p)) ?? list),
  };
}

type Row = { provider: Provider; label: string; preflight: Preflight | null };

function rows(providers: ProviderInfo[], selected: Provider | null): Row[] {
  const list: Row[] = providers.map((p) => ({ ...p }));
  // A task can use a provider the server no longer offers (Mock in a packaged build, say).
  if (selected && !list.some((r) => r.provider === selected)) {
    list.push({ provider: selected, label: selected, preflight: null });
  }
  return list;
}

function loginText(loggedIn: boolean | null): string {
  if (loggedIn === true) return 'logged in';
  if (loggedIn === false) return 'not logged in';
  return 'login unknown';
}

function ReadinessDetails({ row }: { row: Row }) {
  const p = row.preflight;
  if (!p) {
    return (
      <div className="text-xs" style={{ color: 'var(--color-warning)' }}>
        Not offered by the server
      </div>
    );
  }
  return (
    <div className="space-y-0.5 text-xs" style={{ color: 'var(--color-text-muted)' }}>
      <div className="truncate" title={p.binary ?? undefined}>
        {p.binary ? (
          <>
            <span className="font-mono">{p.binary}</span>
            {sourceText(p.source) ? ` (${sourceText(p.source)})` : ''}
            {p.version ? ` · ${p.version}` : ''} · {loginText(p.loggedIn)}
          </>
        ) : (
          'CLI not found'
        )}
      </div>
      {p.problem && (
        <div
          style={{ color: 'var(--color-warning)' }}
          data-testid={`agent-problem-${row.provider}`}
        >
          Fix: {p.problem}
        </div>
      )}
    </div>
  );
}

type AgentPickerProps = {
  state: ProvidersState;
  value: AgentDraft;
  onChange: (value: AgentDraft) => void;
  /** Set when the agent cannot change; the picker is then read-only and says why. */
  lockedReason?: string | null;
};

export function AgentPicker({ state, value, onChange, lockedReason }: AgentPickerProps) {
  const { providers, error, retry, replace } = state;
  const locked = Boolean(lockedReason);
  const list = providers ? rows(providers, value.provider) : [];
  const selected = list.find((r) => r.provider === value.provider);
  const notReady =
    !locked && selected && (!selected.preflight || !readiness(selected.preflight).ready);
  const mode = suggestedMode(value.provider);

  return (
    <div className="space-y-3" data-testid="agent-picker">
      <Label>Agent</Label>

      {lockedReason && (
        <p
          className="text-xs"
          style={{ color: 'var(--color-text-muted)' }}
          data-testid="agent-locked-reason"
        >
          {lockedReason}
        </p>
      )}

      {error ? (
        <div
          className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm"
          style={{ borderColor: 'var(--color-border)', color: 'var(--color-error)' }}
        >
          <span data-testid="agent-providers-error">Could not load the agents: {error}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={retry}
            data-testid="agent-providers-retry"
          >
            Retry
          </Button>
        </div>
      ) : !providers ? (
        <div
          className="flex items-center gap-2 rounded-md border p-3 text-sm"
          style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}
          data-testid="agent-providers-loading"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking which agents are installed…
        </div>
      ) : list.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--color-error)' }}>
          The server offers no agents.
        </p>
      ) : (
        <RadioGroup
          value={value.provider ?? ''}
          onValueChange={(v) => onChange({ provider: v as Provider, model: '', mode: '' })}
          disabled={locked}
          className="gap-2"
        >
          {list.map((row) => {
            const r = row.preflight ? readiness(row.preflight) : { ready: false, label: 'Unknown' };
            const id = `agent-option-${row.provider}`;
            return (
              <label
                key={row.provider}
                htmlFor={id}
                className="flex min-w-0 items-start gap-3 rounded-md border p-3"
                style={{
                  borderColor:
                    value.provider === row.provider
                      ? 'var(--color-primary)'
                      : 'var(--color-border)',
                  cursor: locked ? 'not-allowed' : 'pointer',
                  opacity: locked && value.provider !== row.provider ? 0.6 : 1,
                }}
              >
                <RadioGroupItem id={id} value={row.provider} data-testid={id} className="mt-0.5" />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{row.label}</span>
                    <span
                      className="flex shrink-0 items-center gap-1 text-xs"
                      style={{ color: r.ready ? 'var(--color-success)' : 'var(--color-warning)' }}
                      data-testid={`agent-readiness-${row.provider}`}
                      data-ready={r.ready}
                    >
                      {r.ready ? (
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      ) : (
                        <AlertTriangle className="h-3.5 w-3.5" />
                      )}
                      {r.label}
                    </span>
                  </div>
                  <ReadinessDetails row={row} />
                </div>
              </label>
            );
          })}
        </RadioGroup>
      )}

      {notReady && selected && (
        <p
          className="flex items-start gap-2 text-xs"
          style={{ color: 'var(--color-warning)' }}
          data-testid="agent-not-ready-warning"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {selected.label} is not ready. Its runs will fail until that is fixed.
        </p>
      )}

      {!locked && selected && offerCliChoice(selected.preflight) && (
        <div className="space-y-1">
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {selected.preflight?.binary
              ? `Using a different ${selected.label} install? Choose its file:`
              : `Installed somewhere the app does not look? Choose the ${selected.label} file:`}
          </p>
          <CliPathChooser
            key={selected.provider}
            provider={selected.provider}
            label={selected.label}
            chosen={selected.preflight?.chosen ?? null}
            onChosen={replace}
          />
        </div>
      )}

      {value.provider && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="agent-model" className="text-xs">
              Model (optional)
            </Label>
            <ModelField
              id="agent-model"
              provider={value.provider}
              value={value.model}
              disabled={locked}
              onChange={(model) => onChange({ ...value, model })}
            />
          </div>
          {takesMode(value.provider) && (
            <div className="space-y-1.5">
              <Label htmlFor="agent-mode" className="text-xs">
                Mode (optional)
              </Label>
              <Input
                id="agent-mode"
                data-testid="agent-mode"
                placeholder={mode ? `e.g. ${mode}` : 'Provider default'}
                value={value.mode}
                disabled={locked}
                onChange={(e) => onChange({ ...value, mode: e.target.value })}
              />
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                Used only when no model is set.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Each CLI's model list, asked once per page load (the server keeps it fresh). */
const modelLists = new Map<Provider, Promise<ModelList>>();

function useModels(provider: Provider | null): ModelList | null {
  const [list, setList] = useState<ModelList | null>(null);
  useEffect(() => {
    if (!provider) return;
    let cancelled = false;
    let pending = modelLists.get(provider);
    if (!pending) {
      pending = api.models(provider);
      // A failed ask is tried again next time.
      pending.catch(() => modelLists.delete(provider));
      modelLists.set(provider, pending);
    }
    pending
      .then((l) => {
        if (!cancelled) setList(l);
      })
      .catch(() => {
        if (!cancelled) setList(null);
      });
    return () => {
      cancelled = true;
    };
  }, [provider]);
  return list && list.provider === provider ? list : null;
}

const OTHER = '__other__';

const selectClass =
  'h-9 w-full min-w-0 rounded-md border bg-transparent px-2 text-sm disabled:cursor-not-allowed disabled:opacity-60';

/**
 * A model: "Default" (the CLI picks), one of the CLI's own models (or the app's list for a CLI
 * that cannot list them), or "Other…" with a typed id.
 */
export function ModelField({
  id,
  provider,
  value,
  disabled,
  onChange,
}: {
  id: string;
  provider: Provider | null;
  value: string;
  disabled?: boolean;
  onChange: (model: string) => void;
}) {
  const list = useModels(provider);
  const models = list?.models ?? [];
  const known = value === '' || models.some((m) => m.id === value);
  const [typing, setTyping] = useState(false);
  const other = typing || !known;
  return (
    <div className="space-y-1.5">
      <select
        id={id}
        data-testid={id}
        className={selectClass}
        style={{ borderColor: 'var(--color-border)' }}
        value={other ? OTHER : value}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value;
          setTyping(v === OTHER);
          onChange(v === OTHER ? '' : v);
        }}
      >
        <option value="">Default (the CLI picks)</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label === m.id ? m.id : `${m.label} (${m.id})`}
          </option>
        ))}
        <option value={OTHER}>Other…</option>
      </select>
      {other && (
        <Input
          data-testid={`${id}-other`}
          placeholder="Model id, as the CLI takes it"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}

/**
 * The agents of a task: one for all three phases (the familiar picker), or one per phase
 * (Planning, Development, QA review), each a CLI, a model and, where the CLI takes one, a mode.
 */
export function PhaseAgentPicker({
  state,
  value,
  onChange,
  lockedReason,
}: {
  state: ProvidersState;
  value: PhaseDrafts;
  onChange: (value: PhaseDrafts) => void;
  lockedReason?: string | null;
}) {
  const locked = Boolean(lockedReason);
  const providers = state.providers ?? [];
  const setPhase = (phase: AgentPhase, draft: AgentDraft) => onChange({ ...value, [phase]: draft });
  return (
    <div className="space-y-3">
      {/* Shown once the agents are known: the default (one agent, or one per phase) depends on
          which are ready, and the box must not flip under a click. */}
      {state.providers && (
        <div className="flex items-center gap-2">
          <Checkbox
            id="agent-same"
            data-testid="agent-same"
            checked={value.same}
            disabled={locked}
            onCheckedChange={(checked) =>
              onChange(checked === true ? sameDrafts(value.dev) : { ...value, same: false })
            }
          />
          <Label htmlFor="agent-same" className="cursor-pointer text-sm">
            Use the same agent for planning, development and QA
          </Label>
        </div>
      )}
      {value.same ? (
        <AgentPicker
          state={state}
          value={value.dev}
          onChange={(draft) => onChange(sameDrafts(draft))}
          lockedReason={lockedReason}
        />
      ) : (
        <div className="space-y-3" data-testid="agent-phases">
          <Label>Agents</Label>
          {lockedReason && (
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {lockedReason}
            </p>
          )}
          {AGENT_PHASES.map((phase) => {
            const draft = value[phase];
            const info = providers.find((p) => p.provider === draft.provider);
            const ready = info ? readiness(info.preflight) : null;
            const mode = suggestedMode(draft.provider);
            return (
              <div
                key={phase}
                className="grid items-start gap-2 sm:grid-cols-[7rem_1fr_1fr]"
                data-testid={`agent-phase-${phase}`}
              >
                <div className="pt-2 text-sm font-medium">{AGENT_PHASE_LABELS[phase]}</div>
                <div className="space-y-1">
                  <select
                    data-testid={`agent-provider-${phase}`}
                    className={selectClass}
                    style={{ borderColor: 'var(--color-border)' }}
                    value={draft.provider ?? ''}
                    disabled={locked}
                    onChange={(e) =>
                      setPhase(phase, { provider: e.target.value as Provider, model: '', mode: '' })
                    }
                  >
                    {providers.map((p) => (
                      <option key={p.provider} value={p.provider}>
                        {p.label}
                        {readiness(p.preflight).ready ? '' : ` (${readiness(p.preflight).label})`}
                      </option>
                    ))}
                  </select>
                  {ready && !ready.ready && (
                    <p className="text-xs" style={{ color: 'var(--color-warning)' }}>
                      {info?.label} is not ready: {ready.label.toLowerCase()}.
                    </p>
                  )}
                  {takesMode(draft.provider) && (
                    <Input
                      data-testid={`agent-mode-${phase}`}
                      placeholder={mode ? `Mode, e.g. ${mode}` : 'Mode'}
                      value={draft.mode}
                      disabled={locked}
                      onChange={(e) => setPhase(phase, { ...draft, mode: e.target.value })}
                    />
                  )}
                </div>
                <ModelField
                  id={`agent-model-${phase}`}
                  provider={draft.provider}
                  value={draft.model}
                  disabled={locked}
                  onChange={(model) => setPhase(phase, { ...draft, model })}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
