'use client';

/**
 * Edit Task Modal
 *
 * Modal for editing blocked tasks - allows modifying description, CLI tool,
 * model selection, etc. and restarting planning.
 */

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogBody,
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
import { Task } from '@/lib/tasks/schema';
import { apiFetch } from '@/lib/api-client';
import { useTaskStore } from '@/store/task-store';
import { toast } from 'sonner';
import { CliReadinessPanel, CliReadinessPlaceholder } from '@/components/tasks/cli-readiness-panel';

type AmpPreflightResult = {
  ampCliPath: string | null;
  authSource: string;
  canRunAmp: boolean;
  instructions: string[];
};

type CursorPreflightResult = {
  agentCliPath: string | null;
  authSource: string;
  canRunCursor: boolean;
  instructions: string[];
};

interface ConfigField {
  name: string;
  label: string;
  type: string;
  options?: { value: string; label: string }[];
  default?: unknown;
  description?: string;
}

interface CLIConfigSchema {
  fields: ConfigField[];
}

interface CLIAdapter {
  name: string;
  displayName: string;
  configSchema: CLIConfigSchema;
}

interface EditTaskModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: Task | null;
}

export function EditTaskModal({ open, onOpenChange, task }: EditTaskModalProps) {
  const { loadTasks } = useTaskStore();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [cliTool, setCliTool] = useState<string>('mock');
  const [cliConfig, setCliConfig] = useState<Record<string, unknown>>({});
  const [requiresHumanReview, setRequiresHumanReview] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [availableAdapters, setAvailableAdapters] = useState<CLIAdapter[]>([]);
  const [isLoadingAdapters, setIsLoadingAdapters] = useState(true);
  const [ampPreflight, setAmpPreflight] = useState<AmpPreflightResult | null>(null);
  const [isCheckingAmp, setIsCheckingAmp] = useState(false);
  const [cursorPreflight, setCursorPreflight] = useState<CursorPreflightResult | null>(null);
  const [isCheckingCursor, setIsCheckingCursor] = useState(false);

  // Pre-fill form only when modal opens (not when task updates from polling)
  // Including `task` in deps would reset user edits every time loadTasks runs
  useEffect(() => {
    if (open && task) {
      setTitle(task.title);
      setDescription(task.description);
      setCliTool(task.cliTool || 'mock');
      setCliConfig((task.cliConfig as Record<string, unknown>) || {});
      setRequiresHumanReview(task.requiresHumanReview || false);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- intentionally omit task to avoid reset on store refresh

  // Fetch available CLI adapters
  useEffect(() => {
    async function fetchAdapters() {
      try {
        const response = await apiFetch('/api/cli/adapters');
        const adapters = await response.json();
        setAvailableAdapters(adapters);
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

  // Amp readiness (delay + retry for packaged app env race)
  useEffect(() => {
    if (!open || cliTool !== 'amp') {
      if (open) setAmpPreflight(null);
      setIsCheckingAmp(false);
      return;
    }
    let cancelled = false;
    setIsCheckingAmp(true);
    const timer = setTimeout(async () => {
      if (cancelled) return;
      try {
        const res = await apiFetch('/api/amp/preflight');
        const data = await res.json();
        if (cancelled) return;
        if (res.ok) {
          if (!data.canRunAmp && data.ampCliPath === null) {
            await new Promise((r) => setTimeout(r, 500));
            if (cancelled) return;
            const retry = await apiFetch('/api/amp/preflight');
            const retryData = await retry.json();
            if (retry.ok) setAmpPreflight(retryData);
            else setAmpPreflight(data);
          } else {
            setAmpPreflight(data);
          }
        } else {
          setAmpPreflight({
            ampCliPath: null,
            authSource: 'missing',
            canRunAmp: false,
            instructions: [data?.error || 'Amp preflight failed'],
          });
        }
      } catch (e) {
        if (!cancelled) {
          setAmpPreflight({
            ampCliPath: null,
            authSource: 'missing',
            canRunAmp: false,
            instructions: [e instanceof Error ? e.message : 'Amp preflight failed'],
          });
        }
      } finally {
        if (!cancelled) setIsCheckingAmp(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setIsCheckingAmp(false);
    };
  }, [open, cliTool]);

  // Cursor readiness (delay + retry for packaged app env race)
  useEffect(() => {
    if (!open || cliTool !== 'cursor') {
      if (open) setCursorPreflight(null);
      setIsCheckingCursor(false);
      return;
    }
    let cancelled = false;
    setIsCheckingCursor(true);
    const timer = setTimeout(async () => {
      if (cancelled) return;
      try {
        const res = await apiFetch('/api/cursor/preflight');
        const data = await res.json();
        if (cancelled) return;
        if (res.ok) {
          if (!data.canRunCursor && data.agentCliPath === null) {
            await new Promise((r) => setTimeout(r, 500));
            if (cancelled) return;
            const retry = await apiFetch('/api/cursor/preflight');
            const retryData = await retry.json();
            if (retry.ok) setCursorPreflight(retryData);
            else setCursorPreflight(data);
          } else {
            setCursorPreflight(data);
          }
        } else {
          setCursorPreflight({
            agentCliPath: null,
            authSource: 'missing',
            canRunCursor: false,
            instructions: [data?.error || 'Cursor preflight failed'],
          });
        }
      } catch (e) {
        if (!cancelled) {
          setCursorPreflight({
            agentCliPath: null,
            authSource: 'missing',
            canRunCursor: false,
            instructions: [e instanceof Error ? e.message : 'Cursor preflight failed'],
          });
        }
      } finally {
        if (!cancelled) setIsCheckingCursor(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setIsCheckingCursor(false);
    };
  }, [open, cliTool]);

  const currentAdapter = availableAdapters.find((a) => a.name === cliTool);
  const configSchema = currentAdapter?.configSchema || null;

  const handleCliChange = (newCli: string) => {
    setCliTool(newCli);
    const adapter = availableAdapters.find((a) => a.name === newCli);
    if (adapter) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  const handleResume = async () => {
    if (!task) return;

    setIsResuming(true);
    try {
      const res = await apiFetch('/api/agents/retry-plan-parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id }),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Failed to resume task');
        return;
      }

      toast.success('Task resumed successfully');
      onOpenChange(false);
      await loadTasks();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to resume');
    } finally {
      setIsResuming(false);
    }
  };

  const handleSaveAndRestart = async () => {
    if (!task || !description.trim()) {
      toast.error('Please fill in the description');
      return;
    }

    setIsSaving(true);
    try {
      const updateRes = await apiFetch('/api/tasks/update', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: task.id,
          title: title.trim() || task.id,
          description: description.trim(),
          cliTool,
          cliConfig,
          requiresHumanReview,
          status: 'pending',
          planningStatus: 'not_started',
          assignedAgent: null,
        }),
      });

      if (!updateRes.ok) {
        const err = await updateRes.json();
        toast.error(err.error || 'Failed to update task');
        return;
      }

      const startRes = await apiFetch('/api/agents/start-planning', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id }),
      });

      if (!startRes.ok) {
        const err = await startRes.json();
        toast.error(err.error || 'Failed to restart planning');
        return;
      }

      toast.success('Task updated and planning restarted');
      onOpenChange(false);
      await loadTasks();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save and restart');
    } finally {
      setIsSaving(false);
    }
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
                {field.options?.map((opt) => (
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
            <Input
              id={field.name}
              type="number"
              value={value as string | number | undefined}
              onChange={(e) => handleConfigChange(field.name, parseInt(e.target.value))}
            />
          </div>
        );

      default:
        return (
          <div key={field.name} className="space-y-2">
            <Label htmlFor={field.name}>{field.label}</Label>
            <Input
              id={field.name}
              value={value as string | undefined}
              onChange={(e) => handleConfigChange(field.name, e.target.value)}
            />
          </div>
        );
    }
  };

  if (!task) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Edit &amp; Restart Task</DialogTitle>
          <DialogDescription>
            {task.status === 'blocked' && task.planningStatus === 'generating_plan'
              ? 'This task was blocked during plan generation. Try Resume to re-parse the plan from logs, or update settings and restart planning.'
              : 'This task was blocked. Update the settings below and restart planning.'}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="title">Task Name</Label>
            <Input
              id="title"
              placeholder="Optional"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

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

          {/* CLI Tool + Readiness - reserve space for both from first paint to avoid layout shift */}
          <div className="space-y-4" style={{ minHeight: '202px' }}>
            <div className="space-y-2 min-h-[76px]">
              <Label htmlFor="cli-tool">CLI Tool</Label>
              {isLoadingAdapters ? (
                <div
                  className="h-10 rounded-md animate-pulse"
                  style={{ background: 'var(--color-surface-hover)' }}
                />
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

            {/* CLI readiness - always present; placeholder when loading adapters or mock selected */}
            {isLoadingAdapters || cliTool === 'mock' ? (
              <CliReadinessPlaceholder />
            ) : cliTool === 'amp' ? (
              <CliReadinessPanel
                title="Amp readiness"
                isLoading={isCheckingAmp}
                statusLabel={ampPreflight?.canRunAmp ? 'Ready' : 'Not ready'}
              >
                {ampPreflight && (
                  <div className="space-y-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    <div>
                      CLI: {ampPreflight.ampCliPath ? ampPreflight.ampCliPath : 'not found'}
                    </div>
                    <div>Auth: {ampPreflight.authSource}</div>
                  </div>
                )}
                {ampPreflight &&
                  !ampPreflight.canRunAmp &&
                  ampPreflight.instructions.length > 0 && (
                    <div className="space-y-1 text-xs pt-2">
                      <div className="font-medium">Fix steps</div>
                      <ul className="list-disc pl-5" style={{ color: 'var(--color-text-muted)' }}>
                        {ampPreflight.instructions.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </div>
                  )}
              </CliReadinessPanel>
            ) : cliTool === 'cursor' ? (
              <CliReadinessPanel
                title="Cursor readiness"
                isLoading={isCheckingCursor}
                statusLabel={cursorPreflight?.canRunCursor ? 'Ready' : 'Not ready'}
              >
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
                    <div className="space-y-1 text-xs pt-2">
                      <div className="font-medium">Fix steps</div>
                      <ul className="list-disc pl-5" style={{ color: 'var(--color-text-muted)' }}>
                        {cursorPreflight.instructions.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </div>
                  )}
              </CliReadinessPanel>
            ) : (
              <CliReadinessPlaceholder />
            )}
          </div>

          {configSchema && configSchema.fields.length > 0 && (
            <div className="space-y-4 pt-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
              <h4 className="text-sm font-medium">CLI Configuration (Model, etc.)</h4>
              {configSchema.fields.map(renderConfigField)}
            </div>
          )}

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
                Plan will ask clarifying questions before development
              </p>
            </div>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={(e) => {
              e.stopPropagation();
              onOpenChange(false);
            }}
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              background: 'var(--color-surface)',
              color: 'var(--color-text-primary)',
              borderColor: 'var(--color-border)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--color-surface-hover)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--color-surface)';
            }}
          >
            Cancel
          </Button>
          {task.status === 'blocked' && task.planningStatus === 'generating_plan' && (
            <Button
              type="button"
              variant="outline"
              onClick={handleResume}
              disabled={isResuming}
              style={{
                background: 'var(--color-surface)',
                color: 'var(--color-primary)',
                borderColor: 'var(--color-primary)',
              }}
            >
              {isResuming ? 'Resuming…' : 'Resume'}
            </Button>
          )}
          <Button
            onClick={handleSaveAndRestart}
            disabled={
              isSaving ||
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
          >
            {isSaving ? 'Saving & Restarting…' : 'Save & Restart Planning'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
