/**
 * Choose an agent's CLI file by hand: a path field, a file picker in the desktop app, and "Use this
 * file". The server checks the file and answers with the agent checked again, which is handed to
 * `onChosen`. With a saved choice (`chosen`), "Find it automatically" goes back to finding the
 * file, which is the way out when a chosen file stops working. Used where an agent is reported
 * missing and in Settings.
 */

import { useState } from 'react';
import { FolderOpen, Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import type { Provider } from '@/lib/api/types/Provider';
import type { ProviderInfo } from '@/lib/api/types/ProviderInfo';
import { cliPathError } from '@/lib/cli-path';
import { native } from '@/lib/native';

type Props = {
  provider: Provider;
  label: string;
  /** The file chosen for this agent, if any, even when it no longer works. */
  chosen: string | null;
  onChosen: (info: ProviderInfo) => void;
};

export function CliPathChooser({ provider, label, chosen, onChosen }: Props) {
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (value: string) => {
    const problem = cliPathError(value);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onChosen(await api.cliPaths.choose(provider, value.trim()));
      setPath('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const browse = async () => {
    let picked: string | null | undefined;
    try {
      picked = await native?.pickFile(`Choose the ${label} CLI file`);
    } catch (e) {
      setError(errorMessage(e));
      return;
    }
    if (picked) {
      setPath(picked);
      await save(picked);
    }
  };

  const findAgain = async () => {
    setSaving(true);
    setError(null);
    try {
      onChosen(await api.cliPaths.choose(provider, null));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-1.5" data-testid={`cli-chooser-${provider}`}>
      <div className="flex gap-2">
        <Input
          value={path}
          placeholder={`Full path to the ${label} CLI`}
          className="font-mono text-xs"
          disabled={saving}
          onChange={(e) => {
            setPath(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void save(path);
            }
          }}
          data-testid={`cli-path-input-${provider}`}
        />
        {native && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => void browse()}
            data-testid={`cli-path-browse-${provider}`}
          >
            <FolderOpen className="h-4 w-4" />
            Choose…
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          disabled={saving || !path.trim()}
          onClick={() => void save(path)}
          data-testid={`cli-path-save-${provider}`}
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          Use this file
        </Button>
      </div>
      {chosen && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={saving}
          onClick={() => void findAgain()}
          data-testid={`cli-path-find-again-${provider}`}
        >
          <RotateCcw className="h-4 w-4" />
          Find it automatically
        </Button>
      )}
      {error && (
        <p
          className="text-xs"
          style={{ color: 'var(--color-error)' }}
          data-testid={`cli-path-error-${provider}`}
        >
          {error}
        </p>
      )}
    </div>
  );
}
