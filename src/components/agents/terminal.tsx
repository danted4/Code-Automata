'use client';

/**
 * Agent Terminal Component
 *
 * Displays real-time agent logs via SSE streaming
 */

import { useEffect, useState, useRef } from 'react';
import { Card } from '@/components/ui/card';
import { AgentLog } from '@/lib/agents/manager';

interface AgentTerminalProps {
  threadId: string;
}

export function AgentTerminal({ threadId }: AgentTerminalProps) {
  const [logs, setLogs] = useState<AgentLog[]>([]);
  const [status, setStatus] = useState<string>('connecting');
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Connect to SSE stream
    const eventSource = new EventSource(
      `/api/agents/stream?threadId=${threadId}`
    );

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'connected') {
          setStatus('running');
        } else if (data.type === 'status') {
          setStatus(data.status);
          eventSource.close();
        } else {
          // Regular log message
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
  }, [threadId]);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const getStatusColor = (status: string) => {
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
  };

  const formatTimestamp = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString();
  };

  return (
    <Card
      className="font-mono text-xs overflow-hidden"
      style={{
        background: 'var(--color-terminal-background)',
        color: 'var(--color-terminal-text)',
      }}
    >
      {/* Header */}
      <div
        className="border-b px-4 py-2 flex items-center justify-between"
        style={{
          borderColor: 'var(--color-border)',
          background: 'var(--color-surface)',
        }}
      >
        <span style={{ color: 'var(--color-text-muted)' }}>Thread: {threadId}</span>
        <span style={{ color: getStatusColor(status) }}>
          ● {status.toUpperCase()}
        </span>
      </div>

      {/* Logs */}
      <div className="p-4 max-h-96 overflow-y-auto">
        {logs.length === 0 && status === 'connecting' && (
          <div style={{ color: 'var(--color-text-muted)' }}>Connecting to agent...</div>
        )}

        {logs.map((log, i) => (
          <div key={i} className="mb-2">
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
    </Card>
  );
}
