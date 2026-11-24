/**
 * Planning rules the question and plan-review modals render: the answer drafts, which required
 * questions are still open, and whether the plan can be reviewed right now.
 */

import type { Answer } from '@/lib/api/types/Answer';
import type { Question } from '@/lib/api/types/Question';
import type { Task } from '@/lib/api/types/Task';
import { PHASE_LABELS, taskStatus, type TaskStatus } from '@/lib/task-view';

/** What the user has entered for one question; empty strings mean nothing. */
export type Draft = { choice: string; note: string };

export type Drafts = Record<string, Draft>;

/** One draft per question, prefilled from any answer already on the task. */
export function initialDrafts(questions: Question[]): Drafts {
  const drafts: Drafts = {};
  for (const q of questions) {
    const choice = q.answer?.choice ?? '';
    drafts[q.id] = {
      choice: q.options?.includes(choice) ? choice : '',
      note: q.answer?.note ?? '',
    };
  }
  return drafts;
}

function hasOptions(q: Question): boolean {
  return (q.options?.length ?? 0) > 0;
}

/** Whether the user has entered anything for the question. */
export function isAnswered(q: Question, draft: Draft | undefined): boolean {
  return !!(draft?.choice || draft?.note.trim());
}

/**
 * Whether the question may be submitted as drafted: an optional question always may; a required
 * one needs a choice, or a non-empty note when it offers no options.
 */
export function isSatisfied(q: Question, draft: Draft | undefined): boolean {
  if (!q.required) return true;
  return hasOptions(q) ? !!draft?.choice : !!draft?.note.trim();
}

/** Required questions that still need an answer, in order. */
export function missingRequired(questions: Question[], drafts: Drafts): Question[] {
  return questions.filter((q) => !isSatisfied(q, drafts[q.id]));
}

/**
 * The answers to send: one per question, with only the fields the user filled in. An optional
 * question left empty is sent as `{}` ("no answer"), so it also clears an earlier answer.
 */
export function buildAnswers(questions: Question[], drafts: Drafts): Record<string, Answer> {
  const answers: Record<string, Answer> = {};
  for (const q of questions) {
    const draft = drafts[q.id];
    const answer: Answer = {};
    if (draft?.choice && q.options?.includes(draft.choice)) answer.choice = draft.choice;
    const note = draft?.note.trim();
    if (note) answer.note = note;
    answers[q.id] = answer;
  }
  return answers;
}

/** Whether the task is still waiting for answers to its questions. */
export function awaitsAnswers(task: Task): boolean {
  return task.phase === 'planning' && task.planning.stage === 'questions';
}

/** What the plan review modal can do with the task right now. */
export type PlanReviewState =
  /** A plan waiting for the user: approve, request changes or edit. */
  | { kind: 'reviewable' }
  /** A revision has been asked for and is queued or being written. */
  | { kind: 'revising' }
  /** A revision run stopped (paused, interrupted or failed) before it finished. */
  | { kind: 'revision_halted'; status: TaskStatus }
  /** Some other run is active on the task. */
  | { kind: 'working'; label: string }
  /** Nothing to review: the task moved on, or the plan was approved or replaced. */
  | { kind: 'closed'; message: string };

export function planReviewState(task: Task): PlanReviewState {
  if (task.phase !== 'planning') {
    return { kind: 'closed', message: `The task has moved to ${PHASE_LABELS[task.phase]}.` };
  }
  const stage = task.planning.stage;
  if (stage === 'approved') return { kind: 'closed', message: 'The plan has been approved.' };
  if (stage !== 'plan_ready') {
    return { kind: 'closed', message: 'There is no plan waiting for review.' };
  }
  const status = taskStatus(task);
  if (task.planning.revision) {
    // A queued revision has no run record yet, so the status reads as `ready` until it starts.
    if (status.kind === 'working' || status.kind === 'ready') return { kind: 'revising' };
    return { kind: 'revision_halted', status };
  }
  if (status.kind === 'working') return { kind: 'working', label: status.label };
  return { kind: 'reviewable' };
}
