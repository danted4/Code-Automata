/**
 * Settings section: the CLI file each agent uses on this computer, how it was found, and a way to
 * choose another or go back to finding it. Changes apply at once and are not part of the project's
 * Save: they belong to the computer, not the project.
 */

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { CliPathChooser } from '@/components/tasks/cli-path-chooser';
import { api, errorMessage } from '@/lib/api';
import type { ProviderInfo } from '@/lib/api/types/ProviderInfo';
import { readiness } from '@/lib/agent-form';
import { canChooseCli, sourceText } from '@/lib/cli-path';

const muted = { color: 'var(--color-text-muted)' };

export function AgentClis() {
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  /** Loading the list failed; errors of a choice show beside that agent. */
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .providers()
      .then((list) => {
        if (!cancelled) setProviders(list.filter((p) => canChooseCli(p.provider)));
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const replace = (info: ProviderInfo) =>
    setProviders((list) => list?.map((p) => (p.provider === info.provider ? info : p)) ?? list);

  if (error) {
    return (
      <p className="text-sm" style={{ color: 'var(--color-error)' }} data-testid="agent-clis-error">
        {error}
      </p>
    );
  }
  if (!providers) {
    return (
      <p className="flex items-center gap-2 text-sm" style={muted}>
        <Loader2 className="h-4 w-4 animate-spin" /> Checking the agents…
      </p>
    );
  }
  return (
    <div className="space-y-5" data-testid="agent-clis">
      {providers.map((info) => {
        const p = info.preflight;
        const source = sourceText(p.source);
        return (
          <div key={info.provider} className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">{info.label}</span>
              <span className="text-xs" style={muted}>
                {readiness(p).label}
              </span>
            </div>
            <p
              className="truncate text-xs"
              style={muted}
              title={p.binary ?? undefined}
              data-testid={`agent-cli-current-${info.provider}`}
            >
              {p.binary ? (
                <>
                  <span className="font-mono">{p.binary}</span>
                  {source ? ` (${source})` : ''}
                </>
              ) : (
                'Not found'
              )}
            </p>
            {p.problem && (
              <p className="text-xs" style={{ color: 'var(--color-warning)' }}>
                {p.problem}
              </p>
            )}
            <CliPathChooser
              provider={info.provider}
              label={info.label}
              chosen={p.chosen}
              onChosen={replace}
            />
          </div>
        );
      })}
    </div>
  );
}
