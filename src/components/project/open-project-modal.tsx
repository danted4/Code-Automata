'use client';

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
import { useProjectStore } from '@/store/project-store';
import { apiFetch } from '@/lib/api-client';
import { FolderOpen, FolderSearch } from 'lucide-react';

interface OpenProjectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function OpenProjectModal({ open, onOpenChange }: OpenProjectModalProps) {
  const { setProjectPath, addRecentPath, recentPaths } = useProjectStore();
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
      const response = await apiFetch(`/api/project/validate?path=${encodeURIComponent(trimmed)}`);
      const data = await response.json();

      if (!response.ok || !data.valid) {
        setError(data.error || 'Invalid path');
        return false;
      }

      setProjectPath(trimmed);
      addRecentPath(trimmed);
      onOpenChange(false);
      setPathInput('');
      setError(null);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Validation failed');
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
    if (typeof window === 'undefined' || !window.electron?.openFolderDialog) {
      return;
    }
    try {
      const path = await window.electron.openFolderDialog();
      if (path) {
        setPathInput(path);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open folder picker');
    }
  };

  const isElectron = typeof window !== 'undefined' && !!window.electron?.openFolderDialog;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Open Project</DialogTitle>
          <DialogDescription>
            Enter the absolute path to your project directory. The project must be a git repository.
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
              {isElectron && (
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
