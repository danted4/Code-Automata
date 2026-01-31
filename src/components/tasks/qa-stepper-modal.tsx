'use client';

/**
 * Q&A Stepper Modal
 *
 * Modal for answering planning questions with numbered navigation
 */

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogBody,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { PlanningQuestion } from '@/lib/tasks/schema';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface QAStepperModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: string;
  questions: PlanningQuestion[];
}

export function QAStepperModal({ open, onOpenChange, taskId, questions }: QAStepperModalProps) {
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<
    Record<string, { selectedOption: string; additionalText: string }>
  >(
    // Initialize with empty answers
    questions.reduce(
      (acc, q) => {
        acc[q.id] = { selectedOption: '', additionalText: '' };
        return acc;
      },
      {} as Record<string, { selectedOption: string; additionalText: string }>
    )
  );
  const [skippedQuestions, setSkippedQuestions] = useState<Set<string>>(new Set());
  const [isSubmitting, setIsSubmitting] = useState(false);

  const currentQuestion = questions[currentQuestionIndex];
  const isFirstQuestion = currentQuestionIndex === 0;
  const isLastQuestion = currentQuestionIndex === questions.length - 1;

  const handleOptionChange = (option: string) => {
    setAnswers((prev) => ({
      ...prev,
      [currentQuestion.id]: {
        ...prev[currentQuestion.id],
        selectedOption: option,
      },
    }));
  };

  const handleTextChange = (text: string) => {
    setAnswers((prev) => ({
      ...prev,
      [currentQuestion.id]: {
        ...prev[currentQuestion.id],
        additionalText: text,
      },
    }));
  };

  const handlePrevious = () => {
    if (!isFirstQuestion) {
      setCurrentQuestionIndex((prev) => prev - 1);
    }
  };

  const handleNext = () => {
    if (!isLastQuestion) {
      setCurrentQuestionIndex((prev) => prev + 1);
    }
  };

  const handleToggleSkip = () => {
    const isCurrentlySkipped = skippedQuestions.has(currentQuestion.id);

    if (isCurrentlySkipped) {
      // Unskip
      setSkippedQuestions((prev) => {
        const newSet = new Set(prev);
        newSet.delete(currentQuestion.id);
        return newSet;
      });
    } else {
      // Skip
      setSkippedQuestions((prev) => new Set(prev).add(currentQuestion.id));
    }
  };

  const handleJumpToQuestion = (index: number) => {
    setCurrentQuestionIndex(index);
  };

  const canSubmit = () => {
    // Check if ALL questions (required or optional) are either answered or skipped
    return questions.every((q) => answers[q.id]?.selectedOption || skippedQuestions.has(q.id));
  };

  const handleSubmit = async () => {
    // Validate using canSubmit
    if (!canSubmit()) {
      const unanswered = questions.filter(
        (q) => !answers[q.id]?.selectedOption && !skippedQuestions.has(q.id)
      );
      alert(
        `Please answer or skip all questions. Missing: ${unanswered.map((q) => `Q${q.order}`).join(', ')}`
      );
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch('/api/agents/submit-answers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId,
          answers,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        alert(error.error || 'Failed to submit answers');
        return;
      }

      // Close modal and reload page to see updated task
      onOpenChange(false);
      window.location.reload();
    } catch (error) {
      alert('Failed to submit answers');
      console.error(error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const currentAnswer = answers[currentQuestion?.id] || { selectedOption: '', additionalText: '' };
  const isCurrentQuestionSkipped = skippedQuestions.has(currentQuestion?.id);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px]">
        <DialogHeader>
          <DialogTitle>Answer Planning Questions</DialogTitle>
          <DialogDescription>
            Help the AI plan better by answering these clarifying questions
          </DialogDescription>
        </DialogHeader>

        <div
          className="shrink-0 py-3 border-t border-b"
          style={{ borderColor: 'var(--color-border)' }}
        >
          {/* Question Navigation */}
          <div className="text-xs mb-2" style={{ color: 'var(--color-text-muted)' }}>
            Question {currentQuestionIndex + 1} of {questions.length}
          </div>
          <div className="flex gap-2 flex-wrap">
            {questions.map((q, index) => {
              const isAnswered = answers[q.id]?.selectedOption;
              const isSkipped = skippedQuestions.has(q.id);
              const isCurrent = index === currentQuestionIndex;

              return (
                <button
                  key={q.id}
                  onClick={() => handleJumpToQuestion(index)}
                  className="w-8 h-8 rounded-full text-xs font-medium transition-all"
                  style={{
                    background: isCurrent
                      ? 'var(--color-primary)'
                      : isAnswered
                        ? 'var(--color-success)'
                        : isSkipped
                          ? 'var(--color-warning)'
                          : 'var(--color-surface)',
                    color:
                      isCurrent || isAnswered
                        ? '#ffffff'
                        : isSkipped
                          ? '#000000'
                          : 'var(--color-text-secondary)',
                    borderWidth: '2px',
                    borderStyle: 'solid',
                    borderColor: isCurrent
                      ? 'var(--color-primary)'
                      : isAnswered
                        ? 'var(--color-success)'
                        : isSkipped
                          ? 'var(--color-warning)'
                          : 'var(--color-border)',
                  }}
                >
                  {index + 1}
                </button>
              );
            })}
          </div>
        </div>

        <DialogBody>
          {/* Current Question */}
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <div className="flex items-start gap-2">
                <Label
                  className="text-base font-medium"
                  style={{ color: 'var(--color-text-primary)' }}
                >
                  {currentQuestion.question}
                </Label>
                {currentQuestion.required && (
                  <span className="text-xs" style={{ color: 'var(--color-error)' }}>
                    *
                  </span>
                )}
              </div>
            </div>

            {/* MCQ Options */}
            <RadioGroup value={currentAnswer.selectedOption} onValueChange={handleOptionChange}>
              <div className="space-y-2">
                {currentQuestion.options.map((option, idx) => (
                  <div key={idx} className="flex items-center space-x-2">
                    <RadioGroupItem value={option} id={`option-${idx}`} />
                    <Label
                      htmlFor={`option-${idx}`}
                      className="cursor-pointer font-normal"
                      style={{ color: 'var(--color-text-secondary)' }}
                    >
                      {option}
                    </Label>
                  </div>
                ))}
              </div>
            </RadioGroup>

            {/* Additional Text Input */}
            <div className="space-y-2 pt-2">
              <Label
                htmlFor="additional-text"
                className="text-sm"
                style={{ color: 'var(--color-text-muted)' }}
              >
                Additional notes or custom answer (optional)
              </Label>
              <Textarea
                id="additional-text"
                placeholder="Add any additional context or a custom answer..."
                value={currentAnswer.additionalText}
                onChange={(e) => handleTextChange(e.target.value)}
                rows={3}
              />
            </div>
          </div>
        </DialogBody>

        {/* Navigation Footer */}
        <DialogFooter className="flex justify-between items-center gap-2">
          <button
            onClick={handlePrevious}
            disabled={isFirstQuestion}
            className="px-4 py-2 rounded-md text-sm font-medium transition-all flex items-center gap-1"
            style={{
              background: 'var(--color-surface)',
              color: 'var(--color-text-primary)',
              border: '1px solid var(--color-border)',
              opacity: isFirstQuestion ? 0.5 : 1,
              cursor: isFirstQuestion ? 'not-allowed' : 'pointer',
            }}
            onMouseEnter={(e) => {
              if (!isFirstQuestion) {
                e.currentTarget.style.background = 'var(--color-surface-hover)';
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--color-surface)';
            }}
          >
            <ChevronLeft className="w-4 h-4" />
            Previous
          </button>

          <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {questions.filter((q) => answers[q.id]?.selectedOption).length} answered,{' '}
            {skippedQuestions.size} skipped
            {' · '}
            {questions.length -
              questions.filter((q) => answers[q.id]?.selectedOption || skippedQuestions.has(q.id))
                .length}{' '}
            remaining
          </div>

          <div className="flex gap-2">
            {/* Skip/Unskip button - shown on ALL questions */}
            <button
              onClick={handleToggleSkip}
              className="px-4 py-2 rounded-md text-sm font-medium transition-all"
              style={{
                background: isCurrentQuestionSkipped
                  ? 'var(--color-secondary)'
                  : 'var(--color-warning)',
                color: isCurrentQuestionSkipped ? 'var(--color-secondary-text)' : '#000000',
                border: `1px solid ${isCurrentQuestionSkipped ? 'var(--color-secondary)' : 'var(--color-warning)'}`,
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = '0.9';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = '1';
              }}
            >
              {isCurrentQuestionSkipped ? 'Unskip' : 'Skip'}
            </button>

            {/* Next or Submit button */}
            {isLastQuestion ? (
              <button
                onClick={handleSubmit}
                disabled={isSubmitting || !canSubmit()}
                className="px-4 py-2 rounded-md text-sm font-medium transition-all"
                style={{
                  background: canSubmit() ? 'var(--color-info)' : 'var(--color-surface)',
                  color: canSubmit() ? '#ffffff' : 'var(--color-text-muted)',
                  border: `1px solid ${canSubmit() ? 'var(--color-info)' : 'var(--color-border)'}`,
                  opacity: canSubmit() ? 1 : 0.5,
                  cursor: canSubmit() && !isSubmitting ? 'pointer' : 'not-allowed',
                }}
                onMouseEnter={(e) => {
                  if (canSubmit() && !isSubmitting) {
                    e.currentTarget.style.opacity = '0.9';
                  }
                }}
                onMouseLeave={(e) => {
                  if (canSubmit()) {
                    e.currentTarget.style.opacity = '1';
                  }
                }}
              >
                {isSubmitting ? 'Submitting...' : 'Submit Answers'}
              </button>
            ) : (
              <button
                onClick={handleNext}
                className="px-4 py-2 rounded-md text-sm font-medium transition-all flex items-center gap-1"
                style={{
                  background: 'var(--color-info)',
                  color: '#ffffff',
                  border: '1px solid var(--color-info)',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.opacity = '0.9';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.opacity = '1';
                }}
              >
                Next
                <ChevronRight className="w-4 h-4" />
              </button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
