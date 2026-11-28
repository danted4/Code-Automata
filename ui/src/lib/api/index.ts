/**
 * One typed function per server endpoint. Types come from `./types`, generated from Rust.
 */

import { request } from './client';
import type { McpCandidate } from './types/McpCandidate';
import type { MemoryView } from './types/MemoryView';
import type { ModelList } from './types/ModelList';
import type { PhaseAgents } from './types/PhaseAgents';
import type { CliPath } from './types/CliPath';
import type { Answer } from './types/Answer';
import type { DeleteReport } from './types/DeleteReport';
import type { DiskUsage } from './types/DiskUsage';
import type { OpenProjectResponse } from './types/OpenProjectResponse';
import type { Phase } from './types/Phase';
import type { Provider } from './types/Provider';
import type { ProviderInfo } from './types/ProviderInfo';
import type { PrReport } from './types/PrReport';
import type { RepoChanges } from './types/RepoChanges';
import type { RunLogInfo } from './types/RunLogInfo';
import type { RunLogLine } from './types/RunLogLine';
import type { Settings } from './types/Settings';
import type { SettingsResponse } from './types/SettingsResponse';
import type { Task } from './types/Task';
import type { TaskList } from './types/TaskList';
import type { WorktreeEntry } from './types/WorktreeEntry';

export { ApiError, errorMessage } from './client';

const task = (id: string, rest = '') => `/api/tasks/${encodeURIComponent(id)}${rest}`;

export const api = {
  openProject: (path: string) =>
    request<OpenProjectResponse>('POST', '/api/projects/open', { body: { path }, project: path }),
  providers: () => request<ProviderInfo[]>('GET', '/api/providers', { project: null }),
  /** The models a CLI offers: its own list where it can give one, else the app's. */
  models: (provider: Provider) =>
    request<ModelList>('GET', `/api/providers/${encodeURIComponent(provider)}/models`, {
      project: null,
    }),
  /** MCP servers already configured on this computer or in the open project, to import. */
  mcpImport: () => request<McpCandidate[]>('GET', '/api/mcp/import'),

  /** The agent CLI files chosen by hand, kept for this computer (not per project). */
  cliPaths: {
    list: () => request<CliPath[]>('GET', '/api/cli-paths', { project: null }),
    /** `null` goes back to finding the file. Answers with the agent checked again. */
    choose: (provider: Provider, path: string | null) =>
      request<ProviderInfo>('PUT', `/api/cli-paths/${encodeURIComponent(provider)}`, {
        body: { path },
        project: null,
      }),
  },

  tasks: {
    list: () => request<TaskList>('GET', '/api/tasks'),
    get: (id: string) => request<Task>('GET', task(id)),
    create: (body: {
      title: string;
      description: string;
      agents: PhaseAgents;
      requirePlanApproval: boolean;
      start?: boolean;
    }) => request<Task>('POST', '/api/tasks', { body }),
    patch: (
      id: string,
      patch: Partial<Pick<Task, 'title' | 'description' | 'agents' | 'requirePlanApproval'>>
    ) => request<Task>('PATCH', task(id), { body: patch }),
    remove: (id: string) => request<void>('DELETE', task(id)),
    move: (id: string, to: Phase) => request<Task>('POST', task(id, '/move'), { body: { to } }),
    start: (id: string) => request<Task>('POST', task(id, '/start')),
    pause: (id: string) => request<Task>('POST', task(id, '/pause')),
    resume: (id: string) => request<Task>('POST', task(id, '/resume')),
    answer: (id: string, answers: Record<string, Answer>) =>
      request<Task>('POST', task(id, '/answers'), { body: { answers } }),
    revisePlan: (id: string, feedback: string) =>
      request<Task>('POST', task(id, '/plan/revise'), { body: { feedback } }),
    editPlan: (id: string, plan: string) =>
      request<Task>('PUT', task(id, '/plan'), { body: { plan } }),
    approvePlan: (id: string) => request<Task>('POST', task(id, '/plan/approve')),
    rework: (id: string, feedback: string) =>
      request<Task>('POST', task(id, '/rework'), { body: { feedback } }),
    skipSubtask: (id: string, subtaskId: string) =>
      request<Task>('POST', task(id, `/subtasks/${encodeURIComponent(subtaskId)}/skip`)),
    /** Open or update the pull request of every repository the task changed. */
    pullRequests: (id: string) => request<PrReport>('POST', task(id, '/pull-requests')),
    /** The files the task changed, per repository. */
    changes: (id: string) => request<RepoChanges[]>('GET', task(id, '/changes')),
    runs: (id: string) => request<RunLogInfo[]>('GET', task(id, '/runs')),
    runLog: (id: string, name: string) =>
      request<RunLogLine[]>('GET', task(id, `/runs/${encodeURIComponent(name)}`)),
  },

  worktrees: {
    list: () => request<WorktreeEntry[]>('GET', '/api/worktrees'),
    usage: () => request<DiskUsage>('GET', '/api/worktrees/usage'),
    /** `force` discards uncommitted changes in a done task's worktree (asked in the dialog). */
    remove: (taskId: string, force = false) =>
      request<DeleteReport>(
        'DELETE',
        `/api/worktrees/${encodeURIComponent(taskId)}${force ? '?force=true' : ''}`
      ),
  },

  /** The project memory (what earlier tasks learned). */
  memory: {
    get: () => request<MemoryView>('GET', '/api/memory'),
    save: (text: string) => request<MemoryView>('PUT', '/api/memory', { body: { text } }),
  },
  settings: {
    get: () => request<SettingsResponse>('GET', '/api/settings'),
    save: (settings: Settings) =>
      request<SettingsResponse>('PUT', '/api/settings', { body: settings }),
  },
};
