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
        return 'text-blue-400';
      case 'completed':
        return 'text-green-400';
      case 'error':
        return 'text-red-400';
      case 'stopped':
        return 'text-yellow-400';
      default:
        return 'text-gray-400';
    }
  };

  const formatTimestamp = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString();
  };

  return (
    <Card className="bg-slate-950 text-green-400 font-mono text-xs overflow-hidden">
      {/* Header */}
      <div className="border-b border-slate-800 px-4 py-2 flex items-center justify-between bg-slate-900">
        <span className="text-slate-400">Thread: {threadId}</span>
        <span className={getStatusColor(status)}>
          ● {status.toUpperCase()}
        </span>
      </div>

      {/* Logs */}
      <div className="p-4 max-h-96 overflow-y-auto">
        {logs.length === 0 && status === 'connecting' && (
          <div className="text-slate-500">Connecting to agent...</div>
        )}

        {logs.map((log, i) => (
          <div key={i} className="mb-2">
            <span className="text-slate-500">
              [{formatTimestamp(log.timestamp)}]
            </span>{' '}
            <span className="text-blue-400">{log.type}:</span>{' '}
            <span className="text-green-400">
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
