/**
 * Open Project Modal
 *
 * Modal for selecting a project directory. Validates path and saves to store.
 * Shows recent projects for quick re-selection.
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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { projectLabel } from '@/lib/project-view';
import { useProjectStore } from '@/store/project-store';
import { api, errorMessage } from '@/lib/api';
import { FolderOpen, FolderSearch } from 'lucide-react';
import { native } from '@/lib/native';
import { toast } from 'sonner';

interface OpenProjectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function OpenProjectModal({ open, onOpenChange }: OpenProjectModalProps) {
  const { setProjectPath, addRecentPath, recentPaths, projectInfo, setProjectInfo } =
    useProjectStore();
  const [pathInput, setPathInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isValidating, setIsValidating] = useState(false);

  const validateAndOpen = async (path: string) => {
    const trimmed = path.trim();
    if (!trimmed) {
      setError('Please enter a project path');
      return false;
    }

    setIsValidating(true);
    setError(null);

    try {
      // Opens (or finds) the project's engine: a repository root, or a workspace folder.
      const opened = await api.openProject(trimmed);
      const root = String(opened.root);
      setProjectPath(root);
      addRecentPath(root);
      setProjectInfo(root, { kind: opened.kind, repos: opened.repos.length });
      if (opened.kind === 'workspace') {
        toast.success(projectLabel({ kind: opened.kind, repos: opened.repos.length }), {
          description: opened.repos.join(', '),
        });
      }
      if (opened.reconcileProblems.length > 0) {
        toast.warning(`Some tasks could not be checked: ${opened.reconcileProblems.join('; ')}`);
      }
      onOpenChange(false);
      setPathInput('');
      setError(null);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setIsValidating(false);
    }
  };

  const handleOpen = () => validateAndOpen(pathInput);

  const handleRecentClick = (path: string) => {
    setPathInput(path);
    void validateAndOpen(path);
  };

  const handleCancel = () => {
    setPathInput('');
    setError(null);
    onOpenChange(false);
  };

  const handleBrowse = async () => {
    if (!native) {
      return;
    }
    try {
      const path = await native.openFolderDialog();
      if (path) {
        setPathInput(path);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open folder picker');
    }
  };

  const hasNative = !!native;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Open Project</DialogTitle>
          <DialogDescription>
            Enter the absolute path to a git repository&rsquo;s root, or to a folder whose every
            folder is a git repository (a workspace: one task can change several of them).
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4 py-4">
          {recentPaths.length > 0 && (
            <div className="space-y-2">
              <Label>Recent Projects</Label>
              <div className="flex flex-wrap gap-2">
                {recentPaths.map((path) => (
                  <Button
                    key={path}
                    variant="outline"
                    size="sm"
                    onClick={() => handleRecentClick(path)}
                    disabled={isValidating}
                    className="text-left justify-start max-w-full truncate"
                    style={{
                      background: 'var(--color-surface)',
                      color: 'var(--color-text-primary)',
                      borderColor: 'var(--color-border)',
                    }}
                    onMouseEnter={(e) => {
                      if (!isValidating) {
                        e.currentTarget.style.background = 'var(--color-surface-hover)';
                        e.currentTarget.style.borderColor = 'var(--color-border-hover)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'var(--color-surface)';
                      e.currentTarget.style.borderColor = 'var(--color-border)';
                    }}
                  >
                    <FolderOpen className="w-3.5 h-3.5 mr-1.5 shrink-0" />
                    <span className="truncate" title={path}>
                      {path.split(/[/\\]/).pop() || path}
                    </span>
                    {projectInfo[path]?.kind === 'workspace' && (
                      <span
                        className="ml-1.5 text-xs shrink-0"
                        style={{ color: 'var(--color-text-muted)' }}
                      >
                        {projectLabel(projectInfo[path])}
                      </span>
                    )}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="project-path">Project Path</Label>
            <div className="flex gap-2">
              <Input
                id="project-path"
                placeholder={
                  typeof navigator !== 'undefined' &&
                  navigator.platform?.toLowerCase().includes('win')
                    ? 'C:\\Users\\you\\projects\\my-app'
                    : '/Users/you/projects/my-app'
                }
                value={pathInput}
                onChange={(e) => {
                  setPathInput(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleOpen();
                }}
                className="flex-1"
              />
              {hasNative && (
                <Button
                  variant="outline"
                  onClick={handleBrowse}
                  disabled={isValidating}
                  title="Browse for folder"
                  style={{
                    background: 'var(--color-surface)',
                    color: 'var(--color-text-primary)',
                    borderColor: 'var(--color-border)',
                  }}
                  onMouseEnter={(e) => {
                    if (!isValidating) {
                      e.currentTarget.style.background = 'var(--color-surface-hover)';
                      e.currentTarget.style.borderColor = 'var(--color-border-hover)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'var(--color-surface)';
                    e.currentTarget.style.borderColor = 'var(--color-border)';
                  }}
                >
                  <FolderSearch className="w-4 h-4" />
                </Button>
              )}
            </div>
          </div>
          {error && (
            <p className="text-sm" style={{ color: 'var(--color-error)' }}>
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={isValidating}
            style={{
              background: 'var(--color-surface)',
              color: 'var(--color-text-primary)',
              borderColor: 'var(--color-border)',
            }}
            onMouseEnter={(e) => {
              if (!isValidating) {
                e.currentTarget.style.background = 'var(--color-surface-hover)';
                e.currentTarget.style.borderColor = 'var(--color-border-hover)';
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--color-surface)';
              e.currentTarget.style.borderColor = 'var(--color-border)';
            }}
          >
            Cancel
          </Button>
          <Button
            onClick={handleOpen}
            disabled={isValidating}
            style={{
              background: 'var(--color-primary)',
              color: 'var(--color-primary-text)',
            }}
            onMouseEnter={(e) => {
              if (!isValidating) {
                e.currentTarget.style.background = 'var(--color-primary-hover)';
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--color-primary)';
            }}
          >
            {isValidating ? 'Validating...' : 'Open'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
