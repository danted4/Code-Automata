/**
 * WorktreeCard: one worktree with its task, branch, path, state and size. An orphan (its task file
 * is gone) has Delete; a done task's worktree has Remove worktree (the task and branch stay); any
 * other task's worktree goes with the task. Editor and file
 * manager actions need the desktop app (`lib/native`) and are hidden without it.
 */

import { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Code2,
  Copy,
  FolderOpen,
  GitBranch,
  HardDrive,
  HelpCircle,
  Loader2,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { WorktreeEntry } from '@/lib/api/types/WorktreeEntry';
import { native, type NativeApi } from '@/lib/native';
import {
  canDeleteWorktree,
  dirtyLabel,
  formatBytes,
  worktreeAction,
  worktreeTitle,
} from '@/lib/worktree-view';
import { useProjectStore } from '@/store/project-store';

export interface WorktreeCardProps {
  worktree: WorktreeEntry;
  /** Bytes on disk; undefined when unknown. */
  sizeBytes?: number;
  onDelete: (taskId: string) => void;
}

const outlineStyle = {
  backgroundColor: 'var(--color-surface)',
  borderColor: 'var(--color-border)',
  color: 'var(--color-text-primary)',
};

async function pathMissing(n: NativeApi, path: string): Promise<boolean> {
  try {
    return !(await n.pathExists(path));
  } catch {
    return true;
  }
}

export function WorktreeCard({ worktree, sizeBytes, onDelete }: WorktreeCardProps) {
  const projectPath = useProjectStore((s) => s.projectPath);
  const [openingEditor, setOpeningEditor] = useState(false);
  const [openingFolder, setOpeningFolder] = useState(false);
  const deletable = canDeleteWorktree(worktree);
  const action = worktreeAction(worktree);
  const title = worktreeTitle(worktree);

  const openInEditor = async () => {
    if (!native) return;
    if (await pathMissing(native, worktree.path)) {
      toast.error('Worktree path not found');
      return;
    }
    setOpeningEditor(true);
    try {
      const editors = (await native.getAvailableEditors()).filter((e) => e.available !== false);
      const editor = editors.find((e) => e.id === 'cursor') ?? editors[0];
      if (!editor) {
        toast.error('No editor available');
        return;
      }
      const result = await native.openEditorAtPath(worktree.path, editor.id, projectPath);
      if (result.success) toast.success(`Opened in ${editor.label}`);
      else toast.error(result.error ?? 'Failed to open editor');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to open editor');
    } finally {
      setOpeningEditor(false);
    }
  };

  const openInFileManager = async () => {
    if (!native) return;
    if (await pathMissing(native, worktree.path)) {
      toast.error('Worktree path not found');
      return;
    }
    setOpeningFolder(true);
    try {
      const result = await native.openFolder(worktree.path);
      if (!result.success) toast.error(result.error ?? 'Failed to open folder');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to open folder');
    } finally {
      setOpeningFolder(false);
    }
  };

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(worktree.path);
      toast.success('Path copied');
    } catch {
      toast.error('Failed to copy path');
    }
  };

  const dirty = worktree.isDirty;

  return (
    <Card
      data-testid={`worktree-card-${worktree.taskId}`}
      className="rounded-lg border shadow-sm h-full flex flex-col"
      style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle
            data-testid={`worktree-title-${worktree.taskId}`}
            className="text-sm font-medium break-words"
            style={{
              color:
                worktree.taskTitle === null ? 'var(--color-warning)' : 'var(--color-text-primary)',
            }}
          >
            {title}
          </CardTitle>
          <Badge
            data-testid={`worktree-status-${worktree.taskId}`}
            className="text-xs font-normal gap-1 shrink-0"
            style={{
              background:
                dirty === null
                  ? 'var(--color-surface-hover)'
                  : dirty
                    ? 'var(--color-warning)'
                    : 'var(--color-success)',
              color: dirty === null ? 'var(--color-text-secondary)' : dirty ? '#000' : '#fff',
              border: 'none',
            }}
          >
            {dirty === null ? (
              <HelpCircle className="w-3 h-3" />
            ) : dirty ? (
              <AlertCircle className="w-3 h-3" />
            ) : (
              <CheckCircle2 className="w-3 h-3" />
            )}
            {dirtyLabel(dirty)}
          </Badge>
        </div>
        <span className="text-xs font-mono" style={{ color: 'var(--color-text-muted)' }}>
          {worktree.taskId}
        </span>
        <div className="flex items-center gap-1.5 mt-1">
          <GitBranch
            className="w-3.5 h-3.5 shrink-0"
            style={{ color: 'var(--color-text-muted)' }}
          />
          <span
            className="text-xs font-mono truncate"
            style={{ color: 'var(--color-text-secondary)' }}
            title={worktree.branchName ?? undefined}
          >
            {worktree.branchName ?? 'detached HEAD'}
          </span>
        </div>
        <div className="flex items-center gap-1 mt-1">
          <CardDescription
            className="text-xs font-mono truncate flex-1 min-w-0"
            style={{ color: 'var(--color-text-muted)' }}
            title={worktree.path}
          >
            {worktree.path}
          </CardDescription>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            aria-label="Copy path"
            title="Copy path"
            data-testid={`worktree-copy-path-${worktree.taskId}`}
            onClick={copyPath}
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <Copy className="w-3.5 h-3.5" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="py-2 flex-1">
        <div
          className="flex items-center gap-1.5 text-xs"
          style={{ color: 'var(--color-text-secondary)' }}
          data-testid={`worktree-size-${worktree.taskId}`}
        >
          <HardDrive className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
          {sizeBytes === undefined ? 'Size unknown' : formatBytes(sizeBytes)}
        </div>
        {action.note && (
          <p className="text-xs mt-2" style={{ color: 'var(--color-text-muted)' }}>
            {action.note}
          </p>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2 pt-2">
        {native && (
          <>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              style={outlineStyle}
              onClick={openInEditor}
              disabled={openingEditor}
              data-testid={`worktree-open-editor-${worktree.taskId}`}
            >
              {openingEditor ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Code2 className="w-3.5 h-3.5" />
              )}
              Open in editor
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              style={outlineStyle}
              onClick={openInFileManager}
              disabled={openingFolder}
              data-testid={`worktree-open-folder-${worktree.taskId}`}
            >
              {openingFolder ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <FolderOpen className="w-3.5 h-3.5" />
              )}
              Reveal in file manager
            </Button>
          </>
        )}
        {deletable && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs"
            style={{
              backgroundColor: 'var(--color-surface)',
              borderColor: 'var(--color-destructive)',
              color: 'var(--color-destructive)',
            }}
            onClick={() => onDelete(worktree.taskId)}
            data-testid={`worktree-delete-${worktree.taskId}`}
          >
            <Trash2 className="w-3.5 h-3.5" />
            {action.button}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
