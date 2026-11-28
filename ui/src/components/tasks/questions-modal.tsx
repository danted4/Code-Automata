/**
 * Questions Modal: the planning agent's questions, one step at a time. Each question takes a
 * single choice (when it offers options) and a free-text note; submitting sends every answer and
 * the engine goes on to write the plan.
 */

import { useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import type { Question } from '@/lib/api/types/Question';
import {
  awaitsAnswers,
  buildAnswers,
  initialDrafts,
  isAnswered,
  isSatisfied,
  missingRequired,
  type Draft,
  type Drafts,
} from '@/lib/planning';
import { act, useTask } from '@/store/task-store';
import type { TaskModalProps } from './modal-props';

const primaryButton = { background: 'var(--color-primary)', color: 'var(--color-primary-text)' };

export function QuestionsModal({ taskId, open, onOpenChange }: TaskModalProps) {
  const task = useTask(taskId);
  if (!task) return null;
  const questions = task.planning.questions ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px]" data-testid="questions-modal">
        <DialogHeader>
          <DialogTitle>Answer Planning Questions</DialogTitle>
          <DialogDescription>
            The agent asks these before writing the plan for &ldquo;{task.title}&rdquo;.
          </DialogDescription>
        </DialogHeader>
        {awaitsAnswers(task) ? (
          // Keyed on the task so the drafts start afresh for each set of questions.
          <Stepper
            key={task.id}
            taskId={task.id}
            questions={questions}
            onDone={() => onOpenChange(false)}
          />
        ) : (
          <>
            <DialogBody>
              <p
                className="text-sm py-2"
                style={{ color: 'var(--color-text-secondary)' }}
                data-testid="questions-closed"
              >
                These questions are no longer waiting for answers.
              </p>
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Stepper({
  taskId,
  questions,
  onDone,
}: {
  taskId: string;
  questions: Question[];
  onDone: () => void;
}) {
  const [drafts, setDrafts] = useState<Drafts>(() => initialDrafts(questions));
  const [index, setIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const last = Math.max(questions.length - 1, 0);
  const step = Math.min(index, last);
  const question = questions[step];
  const missing = missingRequired(questions, drafts);
  const answered = questions.filter((q) => isAnswered(q, drafts[q.id])).length;

  const update = (id: string, change: Partial<Draft>) =>
    setDrafts((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? { choice: '', note: '' }), ...change },
    }));

  const submit = async () => {
    setSubmitting(true);
    const done = await act(
      () => api.tasks.answer(taskId, buildAnswers(questions, drafts)),
      'Answers sent'
    );
    setSubmitting(false);
    if (done) onDone();
  };

  return (
    <>
      {questions.length > 1 && (
        <div
          className="shrink-0 py-3 border-t border-b"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <div className="text-xs mb-2" style={{ color: 'var(--color-text-muted)' }}>
            Question {step + 1} of {questions.length}
          </div>
          <div className="flex gap-2 flex-wrap">
            {questions.map((q, i) => (
              <StepDot
                key={q.id}
                number={i + 1}
                current={i === step}
                answered={isAnswered(q, drafts[q.id])}
                onClick={() => setIndex(i)}
                testId={`questions-step-${q.id}`}
              />
            ))}
          </div>
        </div>
      )}

      <DialogBody>
        {question ? (
          <QuestionStep
            question={question}
            draft={drafts[question.id] ?? { choice: '', note: '' }}
            onChange={(change) => update(question.id, change)}
          />
        ) : (
          <p className="text-sm py-2" style={{ color: 'var(--color-text-secondary)' }}>
            The agent asked no questions. Send to go on to the plan.
          </p>
        )}
      </DialogBody>

      <DialogFooter className="flex sm:justify-between items-center gap-2">
        <Button
          variant="outline"
          onClick={() => setIndex(step - 1)}
          disabled={step === 0 || submitting}
          data-testid="questions-back"
        >
          <ChevronLeft className="w-4 h-4" />
          Back
        </Button>
        <div
          className="text-xs text-center"
          style={{ color: missing.length ? 'var(--color-warning)' : 'var(--color-text-muted)' }}
          data-testid="questions-summary"
        >
          {answered} of {questions.length} answered
          {missing.length > 0 && ` · ${missing.length} required still open`}
        </div>
        {step < last ? (
          <Button
            onClick={() => setIndex(step + 1)}
            disabled={submitting}
            style={primaryButton}
            data-testid="questions-next"
          >
            Next
            <ChevronRight className="w-4 h-4" />
          </Button>
        ) : (
          <Button
            onClick={submit}
            disabled={submitting || missing.length > 0}
            title={
              missing.length > 0
                ? `Still needed: ${missing.map((q) => `Q${questions.indexOf(q) + 1}`).join(', ')}`
                : undefined
            }
            style={primaryButton}
            data-testid="questions-submit"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Submit Answers'}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

function StepDot({
  number,
  current,
  answered,
  onClick,
  testId,
}: {
  number: number;
  current: boolean;
  answered: boolean;
  onClick: () => void;
  testId: string;
}) {
  const color = current
    ? 'var(--color-primary)'
    : answered
      ? 'var(--color-success)'
      : 'var(--color-border)';
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-8 h-8 rounded-full text-xs font-medium transition-colors border-2"
      style={{
        borderColor: color,
        background: current || answered ? color : 'var(--color-surface)',
        color: current
          ? 'var(--color-primary-text)'
          : answered
            ? '#ffffff'
            : 'var(--color-text-secondary)',
      }}
      aria-current={current ? 'step' : undefined}
      data-testid={testId}
    >
      {number}
    </button>
  );
}

function QuestionStep({
  question,
  draft,
  onChange,
}: {
  question: Question;
  draft: Draft;
  onChange: (change: Partial<Draft>) => void;
}) {
  const options = question.options ?? [];
  const noteId = `question-note-${question.id}`;
  const unmet = !isSatisfied(question, draft);

  return (
    <div className="space-y-4 py-4" data-testid={`question-${question.id}`}>
      <div className="flex items-start gap-1">
        <p className="text-base font-medium" style={{ color: 'var(--color-text-primary)' }}>
          {question.text}
        </p>
        {question.required && (
          <span className="text-sm" style={{ color: 'var(--color-error)' }} title="Required">
            *
          </span>
        )}
      </div>

      {options.length > 0 && (
        <RadioGroup value={draft.choice} onValueChange={(choice) => onChange({ choice })}>
          {options.map((option, i) => {
            const id = `question-option-${question.id}-${i}`;
            return (
              <div key={id} className="flex items-center gap-2">
                <RadioGroupItem value={option} id={id} data-testid={id} />
                <Label
                  htmlFor={id}
                  className="cursor-pointer font-normal flex-1"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  {option}
                </Label>
              </div>
            );
          })}
        </RadioGroup>
      )}
      {options.length > 0 && draft.choice && !question.required && (
        <button
          type="button"
          className="text-xs underline underline-offset-2"
          style={{ color: 'var(--color-text-muted)' }}
          onClick={() => onChange({ choice: '' })}
          data-testid={`question-clear-${question.id}`}
        >
          Clear choice
        </button>
      )}

      <div className="space-y-2 pt-2">
        <Label htmlFor={noteId} className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
          {options.length > 0 ? 'Note (optional)' : 'Your answer'}
        </Label>
        <Textarea
          id={noteId}
          data-testid={noteId}
          placeholder={
            options.length > 0 ? 'Add any context for your choice…' : 'Type your answer…'
          }
          value={draft.note}
          onChange={(e) => onChange({ note: e.target.value })}
          rows={3}
        />
      </div>

      {/* Kept in the layout once answered (hidden, not removed), so the dialog does not
          shrink when an option is picked. */}
      {question.required && (
        <p
          className="text-xs"
          style={{ color: 'var(--color-warning)', visibility: unmet ? 'visible' : 'hidden' }}
          aria-hidden={!unmet}
          data-testid={`question-hint-${question.id}`}
        >
          {options.length > 0
            ? 'Pick an option to answer this question.'
            : 'This question needs an answer.'}
        </p>
      )}
    </div>
  );
}
