/**
 * One typed function per server endpoint. Types come from `./types`, generated from Rust.
 */

import { request } from './client';
import type { AgentConfig } from './types/AgentConfig';
import type { Answer } from './types/Answer';
import type { DeleteReport } from './types/DeleteReport';
import type { DiskUsage } from './types/DiskUsage';
import type { OpenProjectResponse } from './types/OpenProjectResponse';
import type { Phase } from './types/Phase';
import type { ProviderInfo } from './types/ProviderInfo';
import type { PullRequestResponse } from './types/PullRequestResponse';
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

  tasks: {
    list: () => request<TaskList>('GET', '/api/tasks'),
    get: (id: string) => request<Task>('GET', task(id)),
    create: (body: {
      title: string;
      description: string;
      agent: AgentConfig;
      requirePlanApproval: boolean;
      start?: boolean;
    }) => request<Task>('POST', '/api/tasks', { body }),
    patch: (
      id: string,
      patch: Partial<Pick<Task, 'title' | 'description' | 'agent' | 'requirePlanApproval'>>
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
    pullRequest: (id: string) => request<PullRequestResponse>('POST', task(id, '/pull-request')),
    runs: (id: string) => request<RunLogInfo[]>('GET', task(id, '/runs')),
    runLog: (id: string, name: string) =>
      request<RunLogLine[]>('GET', task(id, `/runs/${encodeURIComponent(name)}`)),
  },

  worktrees: {
    list: () => request<WorktreeEntry[]>('GET', '/api/worktrees'),
    usage: () => request<DiskUsage>('GET', '/api/worktrees/usage'),
    remove: (taskId: string) =>
      request<DeleteReport>('DELETE', `/api/worktrees/${encodeURIComponent(taskId)}`),
  },

  settings: {
    get: () => request<SettingsResponse>('GET', '/api/settings'),
    save: (settings: Settings) =>
      request<SettingsResponse>('PUT', '/api/settings', { body: settings }),
  },
};
