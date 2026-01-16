'use client';

/**
 * Plan Review Modal
 *
 * Modal for reviewing AI-generated implementation plans
 */

import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CheckCircle, Play, Edit, Code, Eye, MessageSquare, Save, X } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface PlanReviewModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: string;
  planContent: string;
  taskTitle: string;
}

export function PlanReviewModal({ open, onOpenChange, taskId, planContent, taskTitle }: PlanReviewModalProps) {
  const [isApproving, setIsApproving] = useState(false);
  const [showModifyMode, setShowModifyMode] = useState(false);
  const [modifyMethod, setModifyMethod] = useState<'inline' | 'feedback' | null>(null);
  const [editedPlan, setEditedPlan] = useState(planContent);
  const [feedbackText, setFeedbackText] = useState('');
  const [showRawMarkdown, setShowRawMarkdown] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const handleApproveOnly = async () => {
    setIsApproving(true);
    try {
      const response = await fetch('/api/agents/approve-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId,
          startDevelopment: false,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        alert(error.error || 'Failed to approve plan');
        return;
      }

      onOpenChange(false);
      window.location.reload();
    } catch (error) {
      alert('Failed to approve plan');
      console.error(error);
    } finally {
      setIsApproving(false);
    }
  };

  const handleApproveAndStart = async () => {
    setIsApproving(true);
    try {
      const response = await fetch('/api/agents/approve-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId,
          startDevelopment: true,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        alert(error.error || 'Failed to approve and start');
        return;
      }

      onOpenChange(false);
      window.location.reload();
    } catch (error) {
      alert('Failed to approve and start');
      console.error(error);
    } finally {
      setIsApproving(false);
    }
  };

  const handleModifyPlan = () => {
    setShowModifyMode(true);
  };

  const handleCancelModify = () => {
    setShowModifyMode(false);
    setModifyMethod(null);
    setEditedPlan(planContent);
    setFeedbackText('');
    setShowRawMarkdown(false);
  };

  const handleSaveInlineEdit = async () => {
    setIsSaving(true);
    try {
      const response = await fetch('/api/agents/modify-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId,
          method: 'inline',
          newPlan: editedPlan,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        alert(error.error || 'Failed to save plan');
        return;
      }

      onOpenChange(false);
      window.location.reload();
    } catch (error) {
      alert('Failed to save plan');
      console.error(error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSubmitFeedback = async () => {
    if (!feedbackText.trim()) {
      alert('Please provide feedback for plan modifications');
      return;
    }

    setIsSaving(true);
    try {
      const response = await fetch('/api/agents/modify-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId,
          method: 'feedback',
          feedback: feedbackText,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        alert(error.error || 'Failed to submit feedback');
        return;
      }

      onOpenChange(false);
      window.location.reload();
    } catch (error) {
      alert('Failed to submit feedback');
      console.error(error);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[900px] max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {showModifyMode ? 'Modify Implementation Plan' : 'Review Implementation Plan'}
          </DialogTitle>
          <DialogDescription>
            {showModifyMode
              ? 'Choose how you want to modify the plan'
              : `Review the AI-generated plan for: ${taskTitle}`
            }
          </DialogDescription>
        </DialogHeader>

        {/* Modify Mode Selection */}
        {showModifyMode && !modifyMethod && (
          <div className="flex flex-col gap-4 py-6">
            <button
              onClick={() => setModifyMethod('inline')}
              className="p-4 rounded-lg border-2 transition-all text-left"
              style={{
                borderColor: 'var(--color-border)',
                background: 'var(--color-surface)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-info)';
                e.currentTarget.style.background = 'var(--color-surface-hover)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-border)';
                e.currentTarget.style.background = 'var(--color-surface)';
              }}
            >
              <div className="flex items-start gap-3">
                <Edit className="w-5 h-5 mt-1" style={{ color: 'var(--color-info)' }} />
                <div>
                  <h3 className="font-semibold mb-1" style={{ color: 'var(--color-text-primary)' }}>
                    Edit Plan Directly
                  </h3>
                  <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                    Manually edit the plan in markdown. Use the visual/raw toggle to switch between modes.
                  </p>
                </div>
              </div>
            </button>

            <button
              onClick={() => setModifyMethod('feedback')}
              className="p-4 rounded-lg border-2 transition-all text-left"
              style={{
                borderColor: 'var(--color-border)',
                background: 'var(--color-surface)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-info)';
                e.currentTarget.style.background = 'var(--color-surface-hover)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-border)';
                e.currentTarget.style.background = 'var(--color-surface)';
              }}
            >
              <div className="flex items-start gap-3">
                <MessageSquare className="w-5 h-5 mt-1" style={{ color: 'var(--color-warning)' }} />
                <div>
                  <h3 className="font-semibold mb-1" style={{ color: 'var(--color-text-primary)' }}>
                    Provide Feedback
                  </h3>
                  <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                    Describe what changes you want, and the AI will regenerate the plan based on your feedback.
                  </p>
                </div>
              </div>
            </button>
          </div>
        )}

        {/* Inline Editor Mode */}
        {showModifyMode && modifyMethod === 'inline' && (
          <div className="flex-1 overflow-hidden flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>
                Edit Plan
              </div>
              <button
                onClick={() => setShowRawMarkdown(!showRawMarkdown)}
                className="px-3 py-1 rounded-md text-xs font-medium transition-all flex items-center gap-1"
                style={{
                  background: 'var(--color-surface)',
                  color: 'var(--color-text-primary)',
                  border: '1px solid var(--color-border)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--color-surface-hover)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'var(--color-surface)';
                }}
              >
                {showRawMarkdown ? (
                  <>
                    <Eye className="w-3 h-3" />
                    Visual
                  </>
                ) : (
                  <>
                    <Code className="w-3 h-3" />
                    Raw
                  </>
                )}
              </button>
            </div>

            {showRawMarkdown ? (
              <Textarea
                value={editedPlan}
                onChange={(e) => setEditedPlan(e.target.value)}
                className="flex-1 font-mono text-sm"
                style={{
                  minHeight: '400px',
                  background: 'var(--color-background)',
                  color: 'var(--color-text-secondary)',
                  border: '1px solid var(--color-border)',
                }}
              />
            ) : (
              <div
                className="flex-1 overflow-y-auto py-4 px-2"
                style={{
                  background: 'var(--color-surface)',
                  borderRadius: '8px',
                  border: '1px solid var(--color-border)',
                }}
              >
                <div className="prose prose-sm max-w-none" style={{ color: 'var(--color-text-primary)' }}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {editedPlan}
                  </ReactMarkdown>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Feedback Mode */}
        {showModifyMode && modifyMethod === 'feedback' && (
          <div className="flex-1 flex flex-col gap-2 py-2">
            <div className="text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>
              Describe the changes you want
            </div>
            <Textarea
              value={feedbackText}
              onChange={(e) => setFeedbackText(e.target.value)}
              placeholder="Example: Add more detail about error handling, include performance considerations, etc."
              className="flex-1"
              style={{
                minHeight: '200px',
                background: 'var(--color-surface)',
                color: 'var(--color-text-primary)',
                border: '1px solid var(--color-border)',
              }}
            />
            <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              The AI will regenerate the plan based on your feedback while keeping the original structure.
            </div>
          </div>
        )}

        {/* Plan Content - Scrollable (only when not in modify mode) */}
        {!showModifyMode && (
        <div
          className="flex-1 overflow-y-auto py-4 px-2"
          style={{
            background: 'var(--color-surface)',
            borderRadius: '8px',
            border: '1px solid var(--color-border)',
          }}
        >
          <div
            className="prose prose-sm max-w-none"
            style={{
              color: 'var(--color-text-primary)',
            }}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                h1: ({ children }) => (
                  <h1 style={{ color: 'var(--color-text-primary)', fontSize: '1.5rem', fontWeight: 'bold', marginTop: '1rem', marginBottom: '0.5rem' }}>
                    {children}
                  </h1>
                ),
                h2: ({ children }) => (
                  <h2 style={{ color: 'var(--color-text-primary)', fontSize: '1.25rem', fontWeight: 'bold', marginTop: '1rem', marginBottom: '0.5rem' }}>
                    {children}
                  </h2>
                ),
                h3: ({ children }) => (
                  <h3 style={{ color: 'var(--color-text-primary)', fontSize: '1.1rem', fontWeight: 'bold', marginTop: '0.75rem', marginBottom: '0.5rem' }}>
                    {children}
                  </h3>
                ),
                p: ({ children }) => (
                  <p style={{ color: 'var(--color-text-secondary)', marginBottom: '0.75rem', lineHeight: '1.6' }}>
                    {children}
                  </p>
                ),
                ul: ({ children }) => (
                  <ul style={{ color: 'var(--color-text-secondary)', marginLeft: '1.5rem', marginBottom: '0.75rem', listStyleType: 'disc' }}>
                    {children}
                  </ul>
                ),
                ol: ({ children }) => (
                  <ol style={{ color: 'var(--color-text-secondary)', marginLeft: '1.5rem', marginBottom: '0.75rem', listStyleType: 'decimal' }}>
                    {children}
                  </ol>
                ),
                li: ({ children }) => (
                  <li style={{ marginBottom: '0.25rem' }}>
                    {children}
                  </li>
                ),
                code: ({ children, className }) => {
                  const isInline = !className;
                  return isInline ? (
                    <code style={{
                      background: 'var(--color-background)',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      fontSize: '0.9em',
                      color: 'var(--color-info)',
                    }}>
                      {children}
                    </code>
                  ) : (
                    <code style={{
                      display: 'block',
                      background: 'var(--color-background)',
                      padding: '1rem',
                      borderRadius: '6px',
                      overflowX: 'auto',
                      fontSize: '0.9em',
                      color: 'var(--color-text-secondary)',
                    }}>
                      {children}
                    </code>
                  );
                },
                blockquote: ({ children }) => (
                  <blockquote style={{
                    borderLeft: '4px solid var(--color-info)',
                    paddingLeft: '1rem',
                    marginLeft: '0',
                    fontStyle: 'italic',
                    color: 'var(--color-text-muted)',
                  }}>
                    {children}
                  </blockquote>
                ),
              }}
            >
              {planContent}
            </ReactMarkdown>
          </div>
        </div>
        )}

        {/* Action Buttons */}
        <DialogFooter className="flex justify-end gap-2 pt-4">
          {showModifyMode && modifyMethod ? (
            <>
              <button
                onClick={handleCancelModify}
                className="px-4 py-2 rounded-md text-sm font-medium transition-all flex items-center gap-2"
                style={{
                  background: 'var(--color-surface)',
                  color: 'var(--color-text-primary)',
                  border: '1px solid var(--color-border)',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--color-surface-hover)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'var(--color-surface)';
                }}
              >
                <X className="w-4 h-4" />
                Cancel
              </button>

              <button
                onClick={modifyMethod === 'inline' ? handleSaveInlineEdit : handleSubmitFeedback}
                disabled={isSaving || (modifyMethod === 'feedback' && !feedbackText.trim())}
                className="px-4 py-2 rounded-md text-sm font-medium transition-all flex items-center gap-2"
                style={{
                  background: isSaving || (modifyMethod === 'feedback' && !feedbackText.trim())
                    ? 'var(--color-surface)'
                    : 'var(--color-info)',
                  color: isSaving || (modifyMethod === 'feedback' && !feedbackText.trim())
                    ? 'var(--color-text-muted)'
                    : '#ffffff',
                  border: `1px solid ${isSaving || (modifyMethod === 'feedback' && !feedbackText.trim()) ? 'var(--color-border)' : 'var(--color-info)'}`,
                  cursor: isSaving || (modifyMethod === 'feedback' && !feedbackText.trim()) ? 'not-allowed' : 'pointer',
                  opacity: isSaving || (modifyMethod === 'feedback' && !feedbackText.trim()) ? 0.6 : 1,
                }}
                onMouseEnter={(e) => {
                  if (!isSaving && !(modifyMethod === 'feedback' && !feedbackText.trim())) {
                    e.currentTarget.style.opacity = '0.9';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isSaving && !(modifyMethod === 'feedback' && !feedbackText.trim())) {
                    e.currentTarget.style.opacity = '1';
                  }
                }}
              >
                <Save className="w-4 h-4" />
                {isSaving
                  ? 'Saving...'
                  : modifyMethod === 'inline'
                  ? 'Save Changes'
                  : 'Submit Feedback'}
              </button>
            </>
          ) : showModifyMode && !modifyMethod ? (
            <button
              onClick={handleCancelModify}
              className="px-4 py-2 rounded-md text-sm font-medium transition-all flex items-center gap-2"
              style={{
                background: 'var(--color-surface)',
                color: 'var(--color-text-primary)',
                border: '1px solid var(--color-border)',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--color-surface-hover)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--color-surface)';
              }}
            >
              <X className="w-4 h-4" />
              Back
            </button>
          ) : (
            <>
          <button
            onClick={handleModifyPlan}
            className="px-4 py-2 rounded-md text-sm font-medium transition-all flex items-center gap-2"
            style={{
              background: 'var(--color-secondary)',
              color: 'var(--color-secondary-text)',
              border: '1px solid var(--color-secondary)',
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--color-secondary-hover)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--color-secondary)';
            }}
          >
            <Edit className="w-4 h-4" />
            Modify Plan
          </button>

          <button
            onClick={handleApproveOnly}
            disabled={isApproving}
            className="px-4 py-2 rounded-md text-sm font-medium transition-all flex items-center gap-2"
            style={{
              background: 'var(--color-success)',
              color: '#ffffff',
              border: '1px solid var(--color-success)',
              cursor: isApproving ? 'not-allowed' : 'pointer',
              opacity: isApproving ? 0.7 : 1,
            }}
            onMouseEnter={(e) => {
              if (!isApproving) {
                e.currentTarget.style.opacity = '0.9';
              }
            }}
            onMouseLeave={(e) => {
              if (!isApproving) {
                e.currentTarget.style.opacity = '1';
              }
            }}
          >
            <CheckCircle className="w-4 h-4" />
            {isApproving ? 'Approving...' : 'Only Approve'}
          </button>

          <button
            onClick={handleApproveAndStart}
            disabled={isApproving}
            className="px-4 py-2 rounded-md text-sm font-medium transition-all flex items-center gap-2"
            style={{
              background: 'var(--color-info)',
              color: '#ffffff',
              border: '1px solid var(--color-info)',
              cursor: isApproving ? 'not-allowed' : 'pointer',
              opacity: isApproving ? 0.7 : 1,
            }}
            onMouseEnter={(e) => {
              if (!isApproving) {
                e.currentTarget.style.opacity = '0.9';
              }
            }}
            onMouseLeave={(e) => {
              if (!isApproving) {
                e.currentTarget.style.opacity = '1';
              }
            }}
          >
            <Play className="w-4 h-4" />
            {isApproving ? 'Starting...' : 'Approve & Start'}
          </button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
