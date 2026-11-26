/**
 * Choose an agent's CLI file by hand: a path field, a file picker in the desktop app, and "Use this
 * file". The server checks the file and answers with the agent checked again, which is handed to
 * `onChosen`. Used where an agent is reported missing and in Settings.
 */

import { useState } from 'react';
import { FolderOpen, Loader2 } from 'lucide-react';
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
  onChosen: (info: ProviderInfo) => void;
};

export function CliPathChooser({ provider, label, onChosen }: Props) {
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
    const picked = await native?.pickFile(`Choose the ${label} CLI file`);
    if (picked) {
      setPath(picked);
      await save(picked);
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
