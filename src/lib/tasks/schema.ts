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

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'planning';

export type PlanningStatus =
  | 'not_started'
  | 'generating_questions'
  | 'waiting_for_answers'
  | 'generating_plan'
  | 'plan_ready'
  | 'plan_approved';

export interface PlanningQuestion {
  id: string;
  question: string;
  options: string[];
  answer: {
    selectedOption: string;
    additionalText: string;
  };
  required: boolean;
  order: number;
}

export interface PlanningData {
  questions: PlanningQuestion[];
  generatedAt?: number;
  answeredAt?: number;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface Task {
  id: string;
  title: string;
  description: string;
  phase: WorkflowPhase;
  status: TaskStatus;
  subtasks: Subtask[];

  // CLI Configuration
  cliTool?: string; // 'amp', 'aider', 'cursor', etc.
  cliConfig?: Record<string, any>; // Dynamic CLI-specific config

  // Workflow Control
  requiresHumanReview?: boolean; // If true, task locked until plan approved
  planApproved?: boolean; // Plan approval status
  locked?: boolean; // Locked tasks can't be dragged

  // Planning Phase
  planningStatus?: PlanningStatus; // Current planning stage
  planningData?: PlanningData; // Q&A data
  planContent?: string; // Generated plan.md content
  planningLogsPath?: string; // Path to planning-logs.txt

  // Execution
  assignedAgent?: string; // Thread ID if agent is working on this
  worktreePath?: string;
  branchName?: string; // auto-claude/{task-name}

  // Integrations
  githubIssue?: number;
  gitlabIssue?: number;

  // Timestamps
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
  isTestData?: boolean; // Flag to mark test data for e2e cleanup
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
