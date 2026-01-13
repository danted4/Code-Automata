/**
 * Task Data Schema
 *
 * Simplified 5-phase workflow matching Auto-Claude
 */

export const WORKFLOW_PHASES = [
  'planning',
  'in_progress',
  'ai_review',
  'human_review',
  'done',
] as const;

export type WorkflowPhase = (typeof WORKFLOW_PHASES)[number];

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export interface Task {
  id: string;
  title: string;
  description: string;
  phase: WorkflowPhase;
  status: TaskStatus;
  subtasks: Subtask[];
  assignedAgent?: string; // Thread ID if agent is working on this
  worktreePath?: string;
  branchName?: string; // auto-claude/{task-name}
  githubIssue?: number;
  gitlabIssue?: number;
  createdAt: number;
  updatedAt: number;
  metadata: TaskMetadata;
}

export interface Subtask {
  id: string;
  content: string;
  status: TaskStatus;
  activeForm?: string; // e.g., "Running tests" when in_progress
  completedAt?: number;
}

export interface TaskMetadata {
  estimatedComplexity?: 'low' | 'medium' | 'high';
  dependencies?: string[]; // Other task IDs
  tags?: string[];
}

/**
 * Helper to get phase display name
 */
export function getPhaseDisplayName(phase: WorkflowPhase): string {
  const names: Record<WorkflowPhase, string> = {
    planning: 'Planning',
    in_progress: 'In Progress',
    ai_review: 'AI Review',
    human_review: 'Human Review',
    done: 'Done',
  };
  return names[phase];
}

/**
 * Helper to get phase description
 */
export function getPhaseDescription(phase: WorkflowPhase): string {
  const descriptions: Record<WorkflowPhase, string> = {
    planning: 'Plan and specification review',
    in_progress: 'Active development (WIP)',
    ai_review: 'Automated QA and validation',
    human_review: 'Manual review and approval',
    done: 'Completed tasks',
  };
  return descriptions[phase];
}

/**
 * Helper to get next phase
 */
export function getNextPhase(
  currentPhase: WorkflowPhase
): WorkflowPhase | null {
  const currentIndex = WORKFLOW_PHASES.indexOf(currentPhase);
  if (currentIndex === WORKFLOW_PHASES.length - 1) {
    return null; // Already at last phase
  }
  return WORKFLOW_PHASES[currentIndex + 1];
}

/**
 * Helper to get previous phase
 */
export function getPreviousPhase(
  currentPhase: WorkflowPhase
): WorkflowPhase | null {
  const currentIndex = WORKFLOW_PHASES.indexOf(currentPhase);
  if (currentIndex === 0) {
    return null; // Already at first phase
  }
  return WORKFLOW_PHASES[currentIndex - 1];
}
