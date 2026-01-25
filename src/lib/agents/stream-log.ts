/**
 * Agent stream log persistence (local dev)
 *
 * Next.js route handlers can have isolated module state during dev/HMR.
 * To make `/api/agents/stream` reliable, we persist per-thread logs to disk.
 *
 * Format: NDJSON lines written to `.code-auto/tasks/{taskId}/agent-stream-{threadId}.ndjson`
 */

import fs from 'fs/promises';
import path from 'path';

export type StreamLogLine =
  | { timestamp: number; type: string; content: unknown }
  | { type: 'status'; status: string; error?: unknown };

const ensuredDirs = new Set<string>();

export function getAgentStreamLogPath(taskId: string, threadId: string): string {
  return path.join(process.cwd(), '.code-auto', 'tasks', taskId, `agent-stream-${threadId}.ndjson`);
}

async function ensureDirForFile(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  if (ensuredDirs.has(dir)) return;
  await fs.mkdir(dir, { recursive: true });
  ensuredDirs.add(dir);
}

export async function appendAgentStreamLog(
  taskId: string,
  threadId: string,
  line: StreamLogLine
): Promise<void> {
  const filePath = getAgentStreamLogPath(taskId, threadId);
  await ensureDirForFile(filePath);
  await fs.appendFile(filePath, JSON.stringify(line) + '\n', 'utf-8');
}

