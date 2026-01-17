'use client';

/**
 * Human Review Modal
 *
 * Modal for reviewing completed development and QA work before merging
 * Provides options for:
 * - Creating MR for review (if git enabled)
 * - Reviewing changes locally (if git enabled)
 * - Opening in VS Code or file explorer
 */

import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { GitBranch, Eye, Code2, Folder, AlertCircle } from 'lucide-react';
import { Task, Subtask } from '@/lib/tasks/schema';

interface HumanReviewModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: Task;
}

export function HumanReviewModal({ open, onOpenChange, task }: HumanReviewModalProps) {
  const [isLoading, setIsLoading] = useState(false);

  // Separate dev and QA subtasks
  const devSubtasks = task.subtasks.filter(s => s.type === 'dev');
  const qaSubtasks = task.subtasks.filter(s => s.type === 'qa');

  // Check if git is enabled (for now, mock check based on branchName)
  const isGitEnabled = !!task.branchName;

  const handleCreateMR = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsLoading(true);
    try {
      // TODO: Implement MR creation
      console.log('Creating MR for task:', task.id);
      // await fetch('/api/review/create-mr', { ... });
    } catch (error) {
      console.error('Failed to create MR:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleReviewLocally = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsLoading(true);
    try {
      // TODO: Implement local review (staging MR)
      console.log('Staging MR for local review:', task.id);
      // await fetch('/api/review/stage-mr', { ... });
    } catch (error) {
      console.error('Failed to stage MR:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenVSCode = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsLoading(true);
    try {
      // TODO: Implement VS Code opening
      console.log('Opening VS Code for task:', task.id);
      // await fetch('/api/review/open-vscode', { ... });
    } catch (error) {
      console.error('Failed to open VS Code:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenFolder = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsLoading(true);
    try {
      // TODO: Implement folder opening
      console.log('Opening folder for task:', task.id);
      // await fetch('/api/review/open-folder', { ... });
    } catch (error) {
      console.error('Failed to open folder:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleModalClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };

  const handleDragStart = (e: React.DragEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent 
        className="sm:max-w-[700px] max-h-[90vh] overflow-y-auto"
        onClick={handleModalClick}
        onMouseDown={handleMouseDown}
        onPointerDown={handlePointerDown}
        onDragStart={handleDragStart}
      >
        <DialogHeader>
          <DialogTitle>Human Review - Ready for Merge</DialogTitle>
          <DialogDescription>
            All development and QA tasks are complete. Review the changes and approve for merge.
          </DialogDescription>
        </DialogHeader>

        <div 
          className="space-y-6 py-4"
          onClick={handleModalClick}
          onMouseDown={handleMouseDown}
          onPointerDown={handlePointerDown}
          onDragStart={handleDragStart}
        >
          {/* Completed Work Summary */}
          <div className="space-y-4">
            <h3 className="font-medium text-sm" style={{ color: 'var(--color-text-primary)' }}>
              ✓ Completed Work
            </h3>

            {/* Development Subtasks */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div
                  className="w-3 h-3 rounded-full"
                  style={{ background: 'var(--color-success)' }}
                />
                <span className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                  Development Tasks ({devSubtasks.length})
                </span>
              </div>
              <div className="pl-5 space-y-2">
                {devSubtasks.map((subtask) => (
                  <div
                    key={subtask.id}
                    className="text-xs py-1.5 px-2 rounded"
                    style={{ background: 'var(--color-surface-hover)' }}
                  >
                    <p style={{ color: 'var(--color-text-primary)' }}>{subtask.content}</p>
                    <p className="text-xs mt-1" style={{ color: 'var(--color-text-secondary)' }}>
                      {subtask.label}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            {/* QA Subtasks */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div
                  className="w-3 h-3 rounded-full"
                  style={{ background: '#a78bfa' }}
                />
                <span className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                  QA Verification Tasks ({qaSubtasks.length})
                </span>
              </div>
              <div className="pl-5 space-y-2">
                {qaSubtasks.map((subtask) => (
                  <div
                    key={subtask.id}
                    className="text-xs py-1.5 px-2 rounded"
                    style={{ background: 'var(--color-surface-hover)' }}
                  >
                    <p style={{ color: 'var(--color-text-primary)' }}>{subtask.content}</p>
                    <p className="text-xs mt-1" style={{ color: 'var(--color-text-secondary)' }}>
                      {subtask.label}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Git-based Review Options */}
          {isGitEnabled ? (
            <div className="space-y-3 pt-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
              <h3 className="font-medium text-sm" style={{ color: 'var(--color-text-primary)' }}>
                <GitBranch className="w-4 h-4 inline mr-2" />
                Git Review Options
              </h3>

              <Card
                className="p-4 cursor-pointer transition-colors"
                style={{
                  background: 'var(--color-surface)',
                  borderColor: 'var(--color-border)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--color-primary)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--color-border)';
                }}
              >
                <div className="space-y-3">
                  <div>
                    <h4 className="text-sm font-medium flex items-center gap-2" style={{ color: 'var(--color-text-primary)' }}>
                      <Eye className="w-4 h-4" />
                      Create Merge Request
                    </h4>
                    <p className="text-xs mt-1" style={{ color: 'var(--color-text-secondary)' }}>
                      Push changes and create a merge request for code review
                    </p>
                  </div>
                  <Button
                    onClick={handleCreateMR}
                    disabled={isLoading}
                    size="sm"
                    className="w-full text-xs"
                    style={{
                      background: 'var(--color-primary)',
                      color: 'var(--color-primary-text)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--color-primary-hover)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'var(--color-primary)';
                    }}
                  >
                    {isLoading ? 'Creating...' : 'Create MR'}
                  </Button>
                </div>
              </Card>

              <Card
                className="p-4 cursor-pointer transition-colors"
                style={{
                  background: 'var(--color-surface)',
                  borderColor: 'var(--color-border)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--color-info)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--color-border)';
                }}
              >
                <div className="space-y-3">
                  <div>
                    <h4 className="text-sm font-medium flex items-center gap-2" style={{ color: 'var(--color-text-primary)' }}>
                      <Code2 className="w-4 h-4" />
                      Review Changes Locally
                    </h4>
                    <p className="text-xs mt-1" style={{ color: 'var(--color-text-secondary)' }}>
                      Stage the changes locally for manual review and testing
                    </p>
                  </div>
                  <Button
                    onClick={handleReviewLocally}
                    disabled={isLoading}
                    size="sm"
                    variant="outline"
                    className="w-full text-xs"
                    style={{
                      background: 'var(--color-surface-hover)',
                      color: 'var(--color-text-primary)',
                      borderColor: 'var(--color-border)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--color-background)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'var(--color-surface-hover)';
                    }}
                  >
                    {isLoading ? 'Staging...' : 'Review Locally'}
                  </Button>
                </div>
              </Card>
            </div>
          ) : (
            <div
              className="p-4 rounded border"
              style={{
                background: 'var(--color-warning)',
                borderColor: 'var(--color-warning)',
                opacity: 0.1,
              }}
            >
              <div className="flex gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'var(--color-warning)' }} />
                <p className="text-xs" style={{ color: 'var(--color-text-primary)' }}>
                  Git is not enabled for this project. Use the options below to navigate to the project and review changes manually.
                </p>
              </div>
            </div>
          )}

          {/* File Explorer Options */}
          <div className="space-y-3 pt-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <h3 className="font-medium text-sm" style={{ color: 'var(--color-text-primary)' }}>
              <Folder className="w-4 h-4 inline mr-2" />
              Open Project
            </h3>

            <div className="grid grid-cols-2 gap-3">
              <Card
                className="p-4 cursor-pointer transition-colors"
                style={{
                  background: 'var(--color-surface)',
                  borderColor: 'var(--color-border)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--color-info)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--color-border)';
                }}
              >
                <div className="space-y-2">
                  <h4 className="text-xs font-medium" style={{ color: 'var(--color-text-primary)' }}>
                    VS Code
                  </h4>
                  <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                    Open in editor
                  </p>
                  <Button
                    onClick={handleOpenVSCode}
                    disabled={isLoading}
                    size="sm"
                    variant="outline"
                    className="w-full text-xs mt-2"
                    style={{
                      background: 'var(--color-surface-hover)',
                      color: 'var(--color-text-primary)',
                      borderColor: 'var(--color-border)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--color-background)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'var(--color-surface-hover)';
                    }}
                  >
                    {isLoading ? 'Opening...' : 'Open'}
                  </Button>
                </div>
              </Card>

              <Card
                className="p-4 cursor-pointer transition-colors"
                style={{
                  background: 'var(--color-surface)',
                  borderColor: 'var(--color-border)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--color-info)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--color-border)';
                }}
              >
                <div className="space-y-2">
                  <h4 className="text-xs font-medium" style={{ color: 'var(--color-text-primary)' }}>
                    File Explorer
                  </h4>
                  <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                    Browse files
                  </p>
                  <Button
                    onClick={handleOpenFolder}
                    disabled={isLoading}
                    size="sm"
                    variant="outline"
                    className="w-full text-xs mt-2"
                    style={{
                      background: 'var(--color-surface-hover)',
                      color: 'var(--color-text-primary)',
                      borderColor: 'var(--color-border)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--color-background)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'var(--color-surface-hover)';
                    }}
                  >
                    {isLoading ? 'Opening...' : 'Open'}
                  </Button>
                </div>
              </Card>
            </div>
          </div>

          {/* Task Info */}
          <div className="pt-2 space-y-2 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              <span className="font-medium">Branch:</span> {task.branchName || 'Not set'}
            </p>
            <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              <span className="font-medium">Task ID:</span> {task.id}
            </p>
          </div>
        </div>

        <DialogFooter 
          className="gap-2"
          onClick={handleModalClick}
          onMouseDown={handleMouseDown}
          onPointerDown={handlePointerDown}
          onDragStart={handleDragStart}
        >
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="text-xs"
            style={{
              background: 'var(--color-surface-hover)',
              color: 'var(--color-text-primary)',
              borderColor: 'var(--color-border)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--color-background)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--color-surface-hover)';
            }}
          >
            Close
          </Button>
          <Button
            style={{
              background: 'var(--color-success)',
              color: '#ffffff',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--color-success)';
              e.currentTarget.style.opacity = '0.9';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--color-success)';
              e.currentTarget.style.opacity = '1';
            }}
            className="text-xs"
          >
            ✓ Approve & Merge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
