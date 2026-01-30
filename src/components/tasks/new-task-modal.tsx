'use client';

/**
 * New Task Modal
 *
 * Modal for creating new tasks with CLI tool selection and configuration
 */

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2 } from 'lucide-react';
import { useTaskStore } from '@/store/task-store';

type AmpPreflightResult = {
  ampCliPath: string | null;
  authSource: 'cli_login' | 'env' | 'missing';
  canRunAmp: boolean;
  instructions: string[];
};

type CursorPreflightResult = {
  agentCliPath: string | null;
  authSource: 'cli_login' | 'env' | 'missing';
  canRunCursor: boolean;
  instructions: string[];
};

interface CLIConfigSchema {
  fields: ConfigField[];
}

interface ConfigField {
  name: string;
  label: string;
  type: 'select' | 'number' | 'boolean' | 'text';
  options?: { value: string; label: string }[];
  default?: unknown;
  description?: string;
}

interface CLIAdapter {
  name: string;
  displayName: string;
  configSchema: CLIConfigSchema;
}

interface NewTaskModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NewTaskModal({ open, onOpenChange }: NewTaskModalProps) {
  const { createTask } = useTaskStore();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [cliTool, setCliTool] = useState<string>('mock');
  const [cliConfig, setCliConfig] = useState<Record<string, unknown>>({});
  const [requiresHumanReview, setRequiresHumanReview] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [availableAdapters, setAvailableAdapters] = useState<CLIAdapter[]>([]);
  const [isLoadingAdapters, setIsLoadingAdapters] = useState(true);
  const [ampPreflight, setAmpPreflight] = useState<AmpPreflightResult | null>(null);
  const [isCheckingAmp, setIsCheckingAmp] = useState(false);
  const [cursorPreflight, setCursorPreflight] = useState<CursorPreflightResult | null>(null);
  const [isCheckingCursor, setIsCheckingCursor] = useState(false);

  // Fetch available CLI adapters from API
  useEffect(() => {
    async function fetchAdapters() {
      try {
        const response = await fetch('/api/cli/adapters');
        const adapters = await response.json();
        setAvailableAdapters(adapters);

        // Set default CLI tool and config
        if (adapters.length > 0) {
          const defaultAdapter = adapters[0];
          setCliTool(defaultAdapter.name);

          // Set default config values
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CLI config values vary by adapter
          const defaults: Record<string, any> = {};
          defaultAdapter.configSchema.fields.forEach((field: ConfigField) => {
            if (field.default !== undefined) {
              defaults[field.name] = field.default;
            }
          });
          setCliConfig(defaults);
        }
      } catch (error) {
        console.error('Failed to load CLI adapters:', error);
      } finally {
        setIsLoadingAdapters(false);
      }
    }

    if (open) {
      fetchAdapters();
    }
  }, [open]);

  // Amp readiness (local dev preflight)
  useEffect(() => {
    async function checkAmp() {
      setIsCheckingAmp(true);
      try {
        const res = await fetch('/api/amp/preflight');
        const data = await res.json();
        if (res.ok) {
          setAmpPreflight(data);
        } else {
          setAmpPreflight({
            ampCliPath: null,
            authSource: 'missing',
            canRunAmp: false,
            instructions: [data?.error || 'Amp preflight failed'],
          });
        }
      } catch (e) {
        setAmpPreflight({
          ampCliPath: null,
          authSource: 'missing',
          canRunAmp: false,
          instructions: [e instanceof Error ? e.message : 'Amp preflight failed'],
        });
      } finally {
        setIsCheckingAmp(false);
      }
    }

    if (open && cliTool === 'amp') {
      checkAmp();
    } else if (open) {
      setAmpPreflight(null);
    }
  }, [open, cliTool]);

  // Cursor readiness (local dev preflight)
  useEffect(() => {
    async function checkCursor() {
      setIsCheckingCursor(true);
      try {
        const res = await fetch('/api/cursor/preflight');
        const data = await res.json();
        if (res.ok) {
          setCursorPreflight(data);
        } else {
          setCursorPreflight({
            agentCliPath: null,
            authSource: 'missing',
            canRunCursor: false,
            instructions: [data?.error || 'Cursor preflight failed'],
          });
        }
      } catch (e) {
        setCursorPreflight({
          agentCliPath: null,
          authSource: 'missing',
          canRunCursor: false,
          instructions: [e instanceof Error ? e.message : 'Cursor preflight failed'],
        });
      } finally {
        setIsCheckingCursor(false);
      }
    }

    if (open && cliTool === 'cursor') {
      checkCursor();
    } else if (open) {
      setCursorPreflight(null);
    }
  }, [open, cliTool]);

  // Get config schema for selected CLI
  const currentAdapter = availableAdapters.find((a) => a.name === cliTool);
  const configSchema = currentAdapter?.configSchema || null;

  // Initialize config with defaults when CLI changes
  const handleCliChange = (newCli: string) => {
    setCliTool(newCli);

    // Set default values from schema
    const adapter = availableAdapters.find((a) => a.name === newCli);
    if (adapter) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CLI config values vary by adapter
      const defaults: Record<string, any> = {};
      adapter.configSchema.fields.forEach((field: ConfigField) => {
        if (field.default !== undefined) {
          defaults[field.name] = field.default;
        }
      });
      setCliConfig(defaults);
    } else {
      setCliConfig({});
    }
  };

  const handleConfigChange = (fieldName: string, value: unknown) => {
    setCliConfig((prev) => ({
      ...prev,
      [fieldName]: value,
    }));
  };

  const handleCreate = async () => {
    if (!description.trim()) {
      alert('Please fill in all required fields');
      return;
    }

    setIsCreating(true);

    try {
      const task = await createTask({
        title: title.trim() || '', // Will be set to task ID if empty
        description,
        phase: 'planning',
        status: 'pending',
        subtasks: [],
        cliTool,
        cliConfig,
        requiresHumanReview,
        planApproved: false,
        planningStatus: 'not_started',
        planningLogsPath: `.code-auto/tasks/{task-id}/planning-logs.txt`, // Will be updated with actual ID
        metadata: {
          estimatedComplexity: 'medium',
        },
      });

      // Reset form
      setTitle('');
      setDescription('');
      setCliTool('amp');
      setCliConfig({});
      setRequiresHumanReview(false);

      onOpenChange(false);

      // Always start planning immediately, regardless of human review requirement
      try {
        await fetch('/api/agents/start-planning', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: task.id,
          }),
        });
      } catch (error) {
        console.error('Failed to start planning:', error);
      }
    } catch (error) {
      alert('Failed to create task');
      console.error(error);
    } finally {
      setIsCreating(false);
    }
  };

  // Determine button text based on state
  const getButtonText = () => {
    if (isCreating) {
      return 'Starting...';
    }
    return 'Start Task';
  };

  const renderConfigField = (field: ConfigField) => {
    const value = cliConfig[field.name] ?? field.default;

    switch (field.type) {
      case 'select':
        return (
          <div key={field.name} className="space-y-2">
            <Label htmlFor={field.name}>{field.label}</Label>
            {field.description && (
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {field.description}
              </p>
            )}
            <Select
              value={value as string | undefined}
              onValueChange={(v) => handleConfigChange(field.name, v)}
            >
              <SelectTrigger id={field.name}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {field.options?.map((opt: { value: string; label: string }) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        );

      case 'boolean':
        return (
          <div key={field.name} className="flex items-center space-x-2">
            <Checkbox
              id={field.name}
              checked={value as boolean | 'indeterminate' | undefined}
              onCheckedChange={(checked) => handleConfigChange(field.name, checked)}
            />
            <Label htmlFor={field.name} className="cursor-pointer">
              {field.label}
            </Label>
          </div>
        );

      case 'number':
        return (
          <div key={field.name} className="space-y-2">
            <Label htmlFor={field.name}>{field.label}</Label>
            {field.description && (
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {field.description}
              </p>
            )}
            <Input
              id={field.name}
              type="number"
              value={value as string | number | undefined}
              onChange={(e) => handleConfigChange(field.name, parseInt(e.target.value))}
            />
          </div>
        );

      case 'text':
      default:
        return (
          <div key={field.name} className="space-y-2">
            <Label htmlFor={field.name}>{field.label}</Label>
            {field.description && (
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {field.description}
              </p>
            )}
            <Input
              id={field.name}
              value={value as string | undefined}
              onChange={(e) => handleConfigChange(field.name, e.target.value)}
            />
          </div>
        );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Create New Task</DialogTitle>
          <DialogDescription>
            Configure your task and select the CLI tool to use for implementation
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Task Name */}
          <div className="space-y-2">
            <Label htmlFor="title">Task Name</Label>
            <Input
              id="title"
              placeholder="Optional (will use task ID if empty)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          {/* Task Description */}
          <div className="space-y-2">
            <Label htmlFor="description">Description *</Label>
            <Textarea
              id="description"
              placeholder="Describe what needs to be done..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>

          {/* CLI Tool Selection */}
          <div className="space-y-2" data-testid="new-task-modal-tool-select-area">
            <Label htmlFor="cli-tool">CLI Tool</Label>
            {isLoadingAdapters ? (
              <div
                className="flex h-10 w-full items-center justify-center rounded-md border px-3 py-2 text-sm"
                style={{
                  borderColor: 'var(--color-border)',
                  background: 'var(--color-surface)',
                }}
              >
                <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--color-info)' }} />
              </div>
            ) : (
              <Select value={cliTool} onValueChange={handleCliChange}>
                <SelectTrigger id="cli-tool">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableAdapters.map((adapter) => (
                    <SelectItem key={adapter.name} value={adapter.name}>
                      {adapter.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Tool readiness container */}
          <div
            className="min-h-[88px] rounded-md border p-3"
            style={{ borderColor: 'var(--color-border)' }}
            data-testid="new-task-modal-readiness-area"
          >
            {isLoadingAdapters ||
            (cliTool === 'amp' && isCheckingAmp) ||
            (cliTool === 'cursor' && isCheckingCursor) ? (
              <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--color-text-muted)' }}>
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" style={{ color: 'var(--color-info)' }} />
                <span>Checking…</span>
              </div>
            ) : cliTool === 'amp' ? (
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <div className="font-medium">Amp readiness</div>
                  <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    {ampPreflight?.canRunAmp ? 'Ready' : 'Not ready'}
                  </div>
                </div>
                {ampPreflight && (
                  <div className="space-y-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    <div>CLI: {ampPreflight.ampCliPath ? ampPreflight.ampCliPath : 'not found'}</div>
                    <div>Auth: {ampPreflight.authSource}</div>
                  </div>
                )}
                {ampPreflight && !ampPreflight.canRunAmp && ampPreflight.instructions.length > 0 && (
                  <div className="space-y-1 text-xs">
                    <div className="font-medium">Fix steps</div>
                    <ul className="list-disc pl-5" style={{ color: 'var(--color-text-muted)' }}>
                      {ampPreflight.instructions.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : cliTool === 'cursor' ? (
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <div className="font-medium">Cursor readiness</div>
                  <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    {cursorPreflight?.canRunCursor ? 'Ready' : 'Not ready'}
                  </div>
                </div>
                {cursorPreflight && (
                  <div className="space-y-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    <div>
                      CLI:{' '}
                      {cursorPreflight.agentCliPath ? cursorPreflight.agentCliPath : 'not found'}
                    </div>
                    <div>Auth: {cursorPreflight.authSource}</div>
                  </div>
                )}
                {cursorPreflight &&
                  !cursorPreflight.canRunCursor &&
                  cursorPreflight.instructions.length > 0 && (
                    <div className="space-y-1 text-xs">
                      <div className="font-medium">Fix steps</div>
                      <ul className="list-disc pl-5" style={{ color: 'var(--color-text-muted)' }}>
                        {cursorPreflight.instructions.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </div>
                  )}
              </div>
            ) : (
              <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                No readiness check for this tool
              </p>
            )}
          </div>

          {/* Dynamic CLI Configuration */}
          {configSchema && configSchema.fields.length > 0 && (
            <div className="space-y-4 pt-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
              <h4 className="text-sm font-medium">CLI Configuration</h4>
              {configSchema.fields.map(renderConfigField)}
            </div>
          )}

          {/* Human Review Checkbox */}
          <div
            className="flex items-start gap-3 pt-4 border-t"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <Checkbox
              id="human-review"
              checked={requiresHumanReview}
              onCheckedChange={(checked) => setRequiresHumanReview(checked as boolean)}
              className="mt-1"
            />
            <div className="flex-1 space-y-1">
              <Label htmlFor="human-review" className="cursor-pointer font-medium">
                Require human review for plan
              </Label>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {requiresHumanReview
                  ? 'Plan generation will ask clarifying questions that you can answer before development'
                  : 'Planning will proceed with auto-approval straight to development'}
              </p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="destructive" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={
              isCreating ||
              !description.trim() ||
              (cliTool === 'amp' && (isCheckingAmp || !ampPreflight || !ampPreflight.canRunAmp)) ||
              (cliTool === 'cursor' &&
                (isCheckingCursor || !cursorPreflight || !cursorPreflight.canRunCursor))
            }
            className="font-medium"
            style={{
              background: 'var(--color-primary)',
              color: 'var(--color-primary-text)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--color-primary-hover)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--color-primary)';
            }}
          >
            {getButtonText()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
