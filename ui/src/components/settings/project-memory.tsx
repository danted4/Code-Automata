/**
 * The project memory (`.code-automata/memory.md`): what earlier tasks learned, which every prompt
 * gets. Read and saved on its own (`/api/memory`), not with the settings form.
 */

import { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, api, errorMessage } from '@/lib/api';
import type { MemoryView } from '@/lib/api/types/MemoryView';
import { memoryNote } from '@/lib/settings-form';

const muted = { color: 'var(--color-text-muted)' };

export function ProjectMemory() {
  const [view, setView] = useState<MemoryView | null>(null);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    api.memory
      .get()
      .then((v) => {
        if (!live) return;
        setView(v);
        setText(v.text);
      })
      .catch((e) => {
        if (live) toast.error(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, []);

  if (!view) {
    return <Loader2 className="h-4 w-4 animate-spin" />;
  }

  const save = async () => {
    setSaving(true);
    try {
      const saved = await api.memory.save(text, view.text);
      setView(saved);
      setText(saved.text);
      toast.success('Project memory saved');
    } catch (e) {
      toast.error(errorMessage(e));
      // Changed meanwhile (an agent added a learning): show what is there now.
      if (e instanceof ApiError && e.status === 409) {
        const now = await api.memory.get().catch(() => null);
        if (now) {
          setView(now);
          setText(now.text);
        }
      }
    } finally {
      setSaving(false);
    }
  };

  const note = memoryNote(view);
  return (
    <div className="space-y-2" data-testid="settings-memory">
      <Textarea
        rows={8}
        className="font-mono text-xs"
        placeholder="Nothing learned yet. Agents add a line here when they find something later tasks should know."
        value={text}
        onChange={(e) => setText(e.target.value)}
        data-testid="settings-memory-text"
      />
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          onClick={save}
          disabled={saving || text === view.text}
          data-testid="settings-memory-save"
          style={{ background: 'var(--color-primary)', color: 'var(--color-primary-text)' }}
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save memory
        </Button>
        <span
          className="text-xs"
          style={view.truncated ? { color: 'var(--color-warning)' } : muted}
          data-testid="settings-memory-note"
        >
          {note}
        </span>
      </div>
    </div>
  );
}
