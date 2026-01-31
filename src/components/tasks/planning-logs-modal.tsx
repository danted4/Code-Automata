'use client';

/**
 * Planning Logs Modal
 *
 * Shows live agent logs during planning via SSE.
 * Styled to match other task-related modals.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AgentLog } from '@/lib/agents/manager';
import { buildStreamUrl } from '@/lib/api-client';
import { toast } from 'sonner';

interface PlanningLogsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskTitle: string;
  threadId: string;
}

export function PlanningLogsModal({
  open,
  onOpenChange,
  taskTitle,
  threadId,
}: PlanningLogsModalProps) {
  const [logs, setLogs] = useState<AgentLog[]>([]);
  const [status, setStatus] = useState<string>('connecting');
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    setLogs([]);
    setStatus('connecting');

    const url = buildStreamUrl('/api/agents/stream', { threadId });
    const eventSource = new EventSource(url);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'connected') {
          setStatus('running');
        } else if (data.type === 'status') {
          setStatus(data.status);
          eventSource.close();
        } else {
          setLogs((prev) => [...prev, data]);
        }
      } catch (error) {
        console.error('Failed to parse SSE message:', error);
      }
    };

    eventSource.onerror = () => {
      setStatus('error');
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  }, [open, threadId]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const statusColor = useMemo(() => {
    switch (status) {
      case 'running':
        return 'var(--color-info)';
      case 'completed':
        return 'var(--color-success)';
      case 'error':
        return 'var(--color-error)';
      case 'stopped':
        return 'var(--color-warning)';
      default:
        return 'var(--color-text-muted)';
    }
  }, [status]);

  const formatTimestamp = (timestamp: number) => new Date(timestamp).toLocaleTimeString();

  const logsText = useMemo(() => {
    const lines = logs.map((log) => {
      const content =
        typeof log.content === 'string' ? log.content : JSON.stringify(log.content, null, 2);
      return `[${formatTimestamp(log.timestamp)}] ${log.type}: ${content}`;
    });
    return [`Task: ${taskTitle}`, `Thread: ${threadId}`, `Status: ${status}`, '', ...lines].join(
      '\n'
    );
  }, [logs, status, taskTitle, threadId]);

  const handleCopyLogs = async () => {
    try {
      await navigator.clipboard.writeText(logsText);
      toast.success('Copied logs to clipboard');
    } catch (e) {
      toast.error('Failed to copy logs');
      console.error(e);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[900px]">
        <DialogHeader>
          <DialogTitle>Planning logs</DialogTitle>
          <DialogDescription>
            Live output for: <span className="font-medium">{taskTitle}</span>
          </DialogDescription>
        </DialogHeader>

        {/* Header bar */}
        <div
          className="flex shrink-0 items-center justify-between gap-2 rounded-md border px-3 py-2"
          style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
        >
          <div className="text-xs font-mono" style={{ color: 'var(--color-text-muted)' }}>
            Thread: {threadId}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                handleCopyLogs();
              }}
              disabled={logs.length === 0}
              title={logs.length === 0 ? 'No logs to copy yet' : 'Copy logs to clipboard'}
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
              Copy logs
            </Button>
            <div className="text-xs font-medium" style={{ color: statusColor }}>
              ● {status.toUpperCase()}
            </div>
          </div>
        </div>

        {/* Terminal */}
        <div
          className="mt-3 min-h-0 flex-1 overflow-hidden rounded-lg border"
          style={{
            borderColor: 'var(--color-border)',
            background: 'var(--color-terminal-background)',
            color: 'var(--color-terminal-text)',
          }}
        >
          <div className="h-full overflow-y-auto p-4 font-mono text-xs">
            {logs.length === 0 && status === 'connecting' && (
              <div style={{ color: 'var(--color-text-muted)' }}>Connecting to agent…</div>
            )}

            {logs.map((log, i) => (
              <div key={i} className="mb-2 whitespace-pre-wrap break-words">
                <span style={{ color: 'var(--color-text-muted)' }}>
                  [{formatTimestamp(log.timestamp)}]
                </span>{' '}
                <span style={{ color: 'var(--color-info)' }}>{log.type}:</span>{' '}
                <span style={{ color: 'var(--color-terminal-text)' }}>
                  {typeof log.content === 'string'
                    ? log.content
                    : JSON.stringify(log.content, null, 2)}
                </span>
              </div>
            ))}

            <div ref={logsEndRef} />
          </div>
        </div>

        <div
          className="pt-4 flex justify-end gap-2 border-t"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <Button
            variant="destructive"
            onClick={() => onOpenChange(false)}
            style={{
              background: 'var(--color-destructive)',
              color: 'var(--color-destructive-text)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--color-destructive-hover)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--color-destructive)';
            }}
          >
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
