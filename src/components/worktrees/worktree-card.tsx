'use client';

/**
 * WorktreeCard
 *
 * Card for a single worktree: task ID, branch, path, status (clean/dirty),
 * linked task indicator, orphan badge. Actions: Open in editor, Open in explorer,
 * Copy path (absolute), Delete. Editor/explorer actions require Electron;
 * otherwise shows toast "Use desktop app for this."
 */

import { useState } from 'react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Code2,
  FolderOpen,
  Copy,
  Trash2,
  GitBranch,
  Link2,
  AlertCircle,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { useProjectStore } from '@/store/project-store';
import type { AvailableEditor, EditorId } from '@/types/electron';

export interface WorktreeItem {
  taskId: string;
  path: string;
  branchName: string;
  isDirty: boolean;
  linkedTaskId: string;
  isOrphan: boolean;
  diskUsageBytes?: number;
}

export interface WorktreeCardProps {
  worktree: WorktreeItem;
  onDelete?: (taskId: string) => void | Promise<void>;
}

/** Filter to available editors and sort Cursor first. */
function availableEditorsSorted(editors: AvailableEditor[]): AvailableEditor[] {
  const available = editors.filter((e) => e.available !== false);
  return [...available].sort((a, b) => (a.id === 'cursor' ? -1 : b.id === 'cursor' ? 1 : 0));
}

export function WorktreeCard({ worktree, onDelete }: WorktreeCardProps) {
  const projectPath = useProjectStore((s) => s.projectPath);
  const [openingEditor, setOpeningEditor] = useState(false);
  const [openingFolder, setOpeningFolder] = useState(false);
  const [availableEditors, setAvailableEditors] = useState<AvailableEditor[]>([]);
  const [selectedEditorId, setSelectedEditorId] = useState<EditorId | null>(null);
  const [editorsLoaded, setEditorsLoaded] = useState(false);

  const isElectron = typeof window !== 'undefined' && !!window.electron;
  const desktopMessage = 'Use desktop app for this.';

  const handleOpenInEditor = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isElectron || !window.electron) {
      toast.info(desktopMessage);
      return;
    }
    let editors: AvailableEditor[];
    try {
      const raw = await window.electron.getAvailableEditors();
      editors = availableEditorsSorted(raw);
      if (!editorsLoaded) {
        setAvailableEditors(editors);
        setSelectedEditorId(editors[0]?.id ?? null);
        setEditorsLoaded(true);
      }
    } catch (err) {
      console.error('Failed to load editors', err);
      toast.error('Failed to load editors');
      return;
    }
    if (!editors.length) {
      toast.error('No editor available');
      return;
    }
    const editorId =
      selectedEditorId && editors.some((ed) => ed.id === selectedEditorId)
        ? selectedEditorId
        : editors[0]!.id;
    try {
      const exists = await window.electron.pathExists(worktree.path);
      if (!exists) {
        toast.error('Worktree path not found');
        return;
      }
    } catch {
      toast.error('Worktree path not found');
      return;
    }
    setOpeningEditor(true);
    try {
      const result = await window.electron.openEditorAtPath(
        worktree.path,
        editorId,
        projectPath ?? undefined
      );
      if (result.success) {
        const label = editors.find((ed) => ed.id === editorId)?.label ?? editorId;
        toast.success(`Opened in ${label}`, { description: worktree.path });
      } else {
        toast.error(result.error ?? 'Failed to open editor');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to open editor');
    } finally {
      setOpeningEditor(false);
    }
  };

  const handleOpenInExplorer = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isElectron || !window.electron) {
      toast.info(desktopMessage);
      return;
    }
    try {
      const exists = await window.electron.pathExists(worktree.path);
      if (!exists) {
        toast.error('Worktree path not found');
        return;
      }
    } catch {
      toast.error('Worktree path not found');
      return;
    }
    setOpeningFolder(true);
    try {
      const result = await window.electron.openFolder(worktree.path);
      if (result.success) {
        toast.success('Opened in file explorer', { description: worktree.path });
      } else {
        toast.error(result.error ?? 'Failed to open folder');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to open folder');
    } finally {
      setOpeningFolder(false);
    }
  };

  const handleCopyPath = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const absolutePath = worktree.path;
    try {
      await navigator.clipboard.writeText(absolutePath);
      toast.success('Path copied to clipboard');
    } catch {
      toast.error('Failed to copy path');
    }
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onDelete) return;
    onDelete(worktree.taskId);
  };

  const statusLabel = worktree.isDirty ? 'Dirty' : 'Clean';

  return (
    <Card
      data-testid={`worktree-card-${worktree.taskId}`}
      className="rounded-lg border shadow-sm"
      style={{
        background: 'var(--color-surface)',
        borderColor: 'var(--color-border)',
      }}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>
            Task {worktree.taskId}
          </CardTitle>
          <div className="flex items-center gap-1.5 shrink-0">
            {worktree.isOrphan && (
              <Badge
                variant="secondary"
                className="text-xs"
                style={{
                  background: 'var(--color-warning)',
                  color: '#000',
                  border: 'none',
                }}
              >
                Orphan
              </Badge>
            )}
            <Badge
              className="text-xs font-normal gap-1"
              style={{
                background: worktree.isDirty ? 'var(--color-warning)' : 'var(--color-success)',
                color: worktree.isDirty ? '#000' : '#fff',
                border: 'none',
              }}
            >
              {worktree.isDirty ? (
                <AlertCircle className="w-3 h-3" />
              ) : (
                <CheckCircle2 className="w-3 h-3" />
              )}
              {statusLabel}
            </Badge>
          </div>
        </div>
        <div className="flex items-center gap-1.5 mt-1">
          <GitBranch
            className="w-3.5 h-3.5 shrink-0"
            style={{ color: 'var(--color-text-muted)' }}
          />
          <span
            className="text-xs font-mono truncate"
            style={{ color: 'var(--color-text-secondary)' }}
            title={worktree.branchName}
          >
            {worktree.branchName}
          </span>
        </div>
        {!worktree.isOrphan && worktree.linkedTaskId && (
          <div className="flex items-center gap-1 mt-1">
            <Link2 className="w-3 h-3 shrink-0" style={{ color: 'var(--color-info)' }} />
            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              Linked task: {worktree.linkedTaskId}
            </span>
          </div>
        )}
        <CardDescription
          className="text-xs font-mono mt-1 truncate"
          style={{ color: 'var(--color-text-muted)' }}
          title={worktree.path}
        >
          {worktree.path}
        </CardDescription>
      </CardHeader>
      <CardContent className="py-2">
        {/* Optional: editor picker when multiple editors and Electron */}
        {isElectron && editorsLoaded && availableEditors.length > 1 && (
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              Editor:
            </span>
            <Select
              value={selectedEditorId ?? undefined}
              onValueChange={(v) => setSelectedEditorId(v as EditorId)}
            >
              <SelectTrigger className="h-8 text-xs w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableEditors.map((ed) => (
                  <SelectItem key={ed.id} value={ed.id}>
                    {ed.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2 pt-2">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-xs"
          style={{
            backgroundColor: 'var(--color-surface)',
            borderColor: 'var(--color-border)',
            color: 'var(--color-text-primary)',
          }}
          onClick={handleOpenInEditor}
          disabled={openingEditor}
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
          style={{
            backgroundColor: 'var(--color-surface)',
            borderColor: 'var(--color-border)',
            color: 'var(--color-text-primary)',
          }}
          onClick={handleOpenInExplorer}
          disabled={openingFolder}
        >
          {openingFolder ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <FolderOpen className="w-3.5 h-3.5" />
          )}
          Open in explorer
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-xs"
          style={{
            backgroundColor: 'transparent',
            color: 'var(--color-text-secondary)',
          }}
          onClick={handleCopyPath}
        >
          <Copy className="w-3.5 h-3.5" />
          Copy path
        </Button>
        {onDelete && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs"
            style={{
              backgroundColor: 'var(--color-surface)',
              borderColor: 'var(--color-destructive)',
              color: 'var(--color-destructive)',
            }}
            onClick={handleDelete}
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
