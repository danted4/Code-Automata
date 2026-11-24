import { describe, expect, it } from 'vitest';
import type { Planning } from '@/lib/api/types/Planning';
import type { Question } from '@/lib/api/types/Question';
import type { Run } from '@/lib/api/types/Run';
import type { Task } from '@/lib/api/types/Task';
import {
  awaitsAnswers,
  buildAnswers,
  initialDrafts,
  isAnswered,
  missingRequired,
  planReviewState,
} from './planning';

function task(planning: Partial<Planning>, over: Partial<Task> = {}): Task {
  return {
    schema: 1,
    id: 'task-1',
    title: 'T',
    createdAt: 0,
    updatedAt: 0,
    phase: 'planning',
    agent: { provider: 'claude' },
    requirePlanApproval: true,
    planning: { stage: 'plan_ready', plan: '# Plan', ...planning },
    ...over,
  };
}

function run(over: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    kind: 'plan',
    state: 'running',
    attempt: 1,
    startedAt: 0,
    updatedAt: 0,
    ...over,
  };
}

const choiceQ: Question = { id: 'q1', text: 'Which?', options: ['A', 'B'], required: true };
const textQ: Question = { id: 'q2', text: 'Why?', required: true };
const optionalQ: Question = { id: 'q3', text: 'Anything else?', options: ['X'], required: false };

describe('answer drafts', () => {
  it('prefills from existing answers and drops a choice that is no longer offered', () => {
    const drafts = initialDrafts([
      { ...choiceQ, answer: { choice: 'B', note: 'because' } },
      { ...textQ, answer: { note: 'speed' } },
      { ...optionalQ, answer: { choice: 'gone' } },
    ]);
    expect(drafts).toEqual({
      q1: { choice: 'B', note: 'because' },
      q2: { choice: '', note: 'speed' },
      q3: { choice: '', note: '' },
    });
  });

  it('needs a choice for a required question with options, a note for one without', () => {
    const qs = [choiceQ, textQ, optionalQ];
    expect(missingRequired(qs, initialDrafts(qs)).map((q) => q.id)).toEqual(['q1', 'q2']);
    const drafts = {
      q1: { choice: '', note: 'a note is not a choice' },
      q2: { choice: '', note: '   ' },
      q3: { choice: '', note: '' },
    };
    expect(missingRequired(qs, drafts).map((q) => q.id)).toEqual(['q1', 'q2']);
    expect(isAnswered(choiceQ, drafts.q1)).toBe(true);
    expect(isAnswered(textQ, drafts.q2)).toBe(false);
    drafts.q1.choice = 'A';
    drafts.q2.note = 'fast';
    expect(missingRequired(qs, drafts)).toEqual([]);
  });

  it('sends one answer per question with only the filled fields, notes trimmed', () => {
    const qs = [choiceQ, textQ, optionalQ];
    const answers = buildAnswers(qs, {
      q1: { choice: 'A', note: '' },
      q2: { choice: '', note: '  fast  ' },
      q3: { choice: '', note: '' },
    });
    expect(answers).toEqual({ q1: { choice: 'A' }, q2: { note: 'fast' }, q3: {} });
  });

  it('knows when answers are still awaited', () => {
    expect(awaitsAnswers(task({ stage: 'questions' }))).toBe(true);
    expect(awaitsAnswers(task({ stage: 'answered' }))).toBe(false);
    expect(awaitsAnswers(task({ stage: 'questions' }, { phase: 'in_progress' }))).toBe(false);
  });
});

describe('planReviewState', () => {
  it('is reviewable at plan_ready with nothing running', () => {
    expect(planReviewState(task({})).kind).toBe('reviewable');
  });

  it('shows a revision from the moment it is asked for until the new plan arrives', () => {
    expect(planReviewState(task({ revision: 'more tests' })).kind).toBe('revising');
    expect(planReviewState(task({ revision: 'more tests' }, { run: run() })).kind).toBe('revising');
    expect(
      planReviewState(task({ revision: 'x' }, { run: run({ state: 'failed', error: 'boom' }) }))
    ).toEqual({ kind: 'revision_halted', status: { kind: 'failed', error: 'boom' } });
  });

  it('is closed when the task moved on or the plan was approved', () => {
    expect(planReviewState(task({ stage: 'approved' }))).toEqual({
      kind: 'closed',
      message: 'The plan has been approved.',
    });
    expect(planReviewState(task({}, { phase: 'in_progress' }))).toEqual({
      kind: 'closed',
      message: 'The task has moved to In Progress.',
    });
    expect(planReviewState(task({ stage: 'not_started' })).kind).toBe('closed');
  });
});
