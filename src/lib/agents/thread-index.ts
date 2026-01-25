/**
 * Thread → task index (local dev)
 *
 * Used by `/api/agents/stream` to locate the correct task directory for a thread
 * without relying on in-memory state.
 */

import fs from 'fs/promises';
import path from 'path';

const INDEX_PATH = path.join(process.cwd(), '.code-auto', 'thread-index.json');

async function readIndex(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(INDEX_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, string>;
    return {};
  } catch {
    return {};
  }
}

async function writeIndex(index: Record<string, string>): Promise<void> {
  const dir = path.dirname(INDEX_PATH);
  await fs.mkdir(dir, { recursive: true });
  const tmp = INDEX_PATH + `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await fs.writeFile(tmp, JSON.stringify(index, null, 2), 'utf-8');
  await fs.rename(tmp, INDEX_PATH);
}

export async function setThreadTaskId(threadId: string, taskId: string): Promise<void> {
  const index = await readIndex();
  index[threadId] = taskId;
  await writeIndex(index);
}

export async function getTaskIdForThread(threadId: string): Promise<string | null> {
  const index = await readIndex();
  const taskId = index[threadId];
  return typeof taskId === 'string' ? taskId : null;
}

