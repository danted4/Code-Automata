/**
 * Agent manager registry (local dev)
 *
 * Code-Auto-style alignment:
 * - Provider selection is per-task, not env-driven singleton
 * - Thread → manager lookup enables /stream + /stop to work with multiple providers
 *
 * Notes:
 * - This is intentionally in-memory (works for local dev / long-lived Next server).
 * - For production/serverless, this would need persistence or a dedicated worker process.
 */

import { AgentManager } from '@/lib/agents/manager';
import { CLIFactory, CLIProvider } from '@/lib/cli/factory';
import type { Task } from '@/lib/tasks/schema';
import { ampPreflight } from '@/lib/amp/preflight';

type ManagerEntry = {
  taskId: string;
  provider: CLIProvider;
  cwd: string;
  manager: AgentManager;
  initialized: Promise<void>;
  createdAt: number;
  lastUsedAt: number;
};

type ThreadEntry = {
  taskId: string;
  manager: AgentManager;
};

const managersByTaskId = new Map<string, ManagerEntry>();
const threads = new Map<string, ThreadEntry>();

function resolveProvider(task: Task): CLIProvider {
  const desired = (task.cliTool || 'mock').toLowerCase();
  if (CLIFactory.isProviderAvailable(desired)) return desired;
  return 'mock';
}

function resolveCwd(task: Task): string {
  return task.worktreePath || process.cwd();
}

async function resolveApiKeyForProvider(provider: CLIProvider): Promise<string> {
  if (provider !== 'amp') return 'mock-key';

  const preflight = await ampPreflight();
  if (!preflight.canRunAmp) {
    // Throw a clear error; API routes should surface this verbatim to the UI.
    throw new Error(
      `Amp not ready.\n\n${preflight.instructions.map((s) => `- ${s}`).join('\n')}`
    );
  }

  // Amp SDK typically reads AMP_API_KEY from env; if we hydrated it, it’ll be present now.
  return process.env.AMP_API_KEY || 'amp-cli-login';
}

async function createAndInitializeManager(task: Task): Promise<ManagerEntry> {
  const provider = resolveProvider(task);
  const cwd = resolveCwd(task);
  const mode = (task.cliConfig?.mode as 'smart' | 'rush' | undefined) || 'smart';

  const manager = new AgentManager(provider);

  const initialized = (async () => {
    const apiKey = await resolveApiKeyForProvider(provider);
    await manager.initialize({ apiKey, cwd, mode });
  })();

  return {
    taskId: task.id,
    provider,
    cwd,
    manager,
    initialized,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  };
}

/**
 * Get (or create) an initialized manager for a task.
 * If the task's provider/cwd changed, replace the entry.
 */
export async function getAgentManagerForTask(task: Task): Promise<AgentManager> {
  const desiredProvider = resolveProvider(task);
  const desiredCwd = resolveCwd(task);

  const existing = managersByTaskId.get(task.id);
  if (existing && existing.provider === desiredProvider && existing.cwd === desiredCwd) {
    existing.lastUsedAt = Date.now();
    await existing.initialized;
    return existing.manager;
  }

  const entry = await createAndInitializeManager(task);
  managersByTaskId.set(task.id, entry);
  await entry.initialized;
  return entry.manager;
}

/**
 * Start an agent for a task and register the thread so /stream and /stop can find it.
 */
export async function startAgentForTask(args: {
  task: Task;
  prompt: string;
  workingDir: string;
  onComplete?: (result: { success: boolean; output: string; error?: string }) => void | Promise<void>;
}): Promise<{ threadId: string }> {
  const mgr = await getAgentManagerForTask(args.task);
  const threadId = await mgr.startAgent(args.task.id, args.prompt, {
    workingDir: args.workingDir,
    onComplete: args.onComplete,
  });
  threads.set(threadId, { taskId: args.task.id, manager: mgr });
  return { threadId };
}

export function getAgentSessionByThreadId(threadId: string) {
  const entry = threads.get(threadId);
  if (!entry) return null;
  return entry.manager.getAgentStatus(threadId) || null;
}

export async function stopAgentByThreadId(threadId: string): Promise<{ taskId: string } | null> {
  const entry = threads.get(threadId);
  if (!entry) return null;
  await entry.manager.stopAgent(threadId);
  return { taskId: entry.taskId };
}

