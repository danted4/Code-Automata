/**
 * The MCP servers this project's agents may use (development and QA runs; planning gets none).
 * Rows are part of the settings form and saved with it; Import copies a server already set up for
 * a CLI or in the project's `.mcp.json` into a new row.
 */

import { useState } from 'react';
import { Download, Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage } from '@/lib/api';
import type { McpCandidate } from '@/lib/api/types/McpCandidate';
import { EMPTY_MCP_ROW, type McpRow, mcpRow } from '@/lib/settings-form';

const muted = { color: 'var(--color-text-muted)' };
const errorStyle = { color: 'var(--color-destructive)' };
const selectClass = 'h-9 rounded-md border bg-transparent px-2 text-sm';

export function McpServers({
  rows,
  errors,
  onChange,
}: {
  rows: McpRow[];
  errors?: Record<number, string>;
  onChange: (rows: McpRow[]) => void;
}) {
  const [candidates, setCandidates] = useState<McpCandidate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const set = (i: number, patch: Partial<McpRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const loadCandidates = async () => {
    setLoading(true);
    try {
      setCandidates(await api.mcpImport());
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const names = new Set(rows.map((r) => r.name.trim()));

  return (
    <div className="space-y-3" data-testid="settings-mcp">
      {rows.length === 0 && (
        <p className="text-sm" style={muted}>
          None: agents get no MCP servers, not even your own.
        </p>
      )}
      {rows.map((row, i) => (
        <div
          key={i}
          className="space-y-2 rounded-md border p-3"
          style={{ borderColor: 'var(--color-border)' }}
          data-testid={`settings-mcp-row-${i}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Name"
              placeholder="name"
              value={row.name}
              onChange={(e) => set(i, { name: e.target.value })}
              className="w-40"
              data-testid={`settings-mcp-name-${i}`}
            />
            <select
              aria-label="Kind"
              className={selectClass}
              style={{ borderColor: 'var(--color-border)' }}
              value={row.type}
              onChange={(e) => set(i, { type: e.target.value === 'http' ? 'http' : 'stdio' })}
              data-testid={`settings-mcp-type-${i}`}
            >
              <option value="stdio">Program (stdio)</option>
              <option value="http">Address (HTTP)</option>
            </select>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              aria-label="Remove"
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
              data-testid={`settings-mcp-remove-${i}`}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          {row.type === 'stdio' ? (
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="space-y-1">
                <Label className="text-xs">Command</Label>
                <Input
                  placeholder="npx"
                  value={row.command}
                  onChange={(e) => set(i, { command: e.target.value })}
                  data-testid={`settings-mcp-command-${i}`}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Arguments, one per line</Label>
                <Textarea
                  rows={2}
                  value={row.args}
                  onChange={(e) => set(i, { args: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Variables, NAME=value per line</Label>
                <Textarea
                  rows={2}
                  value={row.env}
                  onChange={(e) => set(i, { env: e.target.value })}
                />
              </div>
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs">Address</Label>
                <Input
                  placeholder="https://example.com/mcp"
                  value={row.url}
                  onChange={(e) => set(i, { url: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Headers, "Name: value" per line</Label>
                <Textarea
                  rows={2}
                  value={row.headers}
                  onChange={(e) => set(i, { headers: e.target.value })}
                />
              </div>
            </div>
          )}
          {errors?.[i] && (
            <p className="text-xs" style={errorStyle} data-testid={`settings-mcp-error-${i}`}>
              {errors[i]}
            </p>
          )}
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange([...rows, { ...EMPTY_MCP_ROW }])}
          data-testid="settings-mcp-add"
        >
          <Plus className="h-4 w-4" /> Add a server
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={loadCandidates}
          disabled={loading}
          data-testid="settings-mcp-import"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          Import…
        </Button>
      </div>
      {candidates && (
        <div
          className="space-y-1 rounded-md border p-3"
          style={{ borderColor: 'var(--color-border)' }}
          data-testid="settings-mcp-candidates"
        >
          {candidates.length === 0 ? (
            <p className="text-sm" style={muted}>
              No MCP servers found in Claude Code, Codex or Gemini CLI settings, or in the project's
              .mcp.json.
            </p>
          ) : (
            candidates.map((c) => (
              <div key={`${c.source}/${c.name}`} className="flex items-center gap-2 text-sm">
                <span className="font-mono">{c.name}</span>
                <span className="text-xs" style={muted}>
                  from {c.source}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-7"
                  disabled={names.has(c.name)}
                  onClick={() => onChange([...rows, mcpRow(c.name, c.server)])}
                  data-testid={`settings-mcp-take-${c.name}`}
                >
                  {names.has(c.name) ? 'Added' : 'Add'}
                </Button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
