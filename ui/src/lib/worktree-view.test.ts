import { describe, expect, it } from 'vitest';
import type { WorktreeEntry } from '@/lib/api/types/WorktreeEntry';
import {
  canDeleteWorktree,
  deleteDialogText,
  cleanupSummary,
  dirtyLabel,
  formatBytes,
  groupWorktrees,
  orphans,
  worktreeAction,
  worktreeTitle,
} from './worktree-view';

describe('formatBytes', () => {
  it('formats each unit', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
    expect(formatBytes(2.25 * 1024 ** 3)).toBe('2.3 GB');
  });

  it('stays in GB for very large values and handles junk', () => {
    expect(formatBytes(3 * 1024 ** 4)).toBe('3072 GB');
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});

describe('worktreeTitle', () => {
  it('uses the task title when there is one', () => {
    expect(worktreeTitle({ taskTitle: 'Add login', orphan: false })).toBe('Add login');
  });

  it('names orphans and unreadable task files', () => {
    expect(worktreeTitle({ taskTitle: null, orphan: true })).toBe('Orphan (task deleted)');
    expect(worktreeTitle({ taskTitle: null, orphan: false })).toBe('Task file unreadable');
  });
});

describe('deleting', () => {
  it('allows orphans and done tasks, and cleans up only orphans', () => {
    expect(canDeleteWorktree({ orphan: true, taskDone: false })).toBe(true);
    expect(canDeleteWorktree({ orphan: false, taskDone: true })).toBe(true);
    expect(canDeleteWorktree({ orphan: false, taskDone: false })).toBe(false);
    expect(
      orphans([
        { orphan: true, taskDone: false },
        { orphan: false, taskDone: true },
        { orphan: true, taskDone: false },
      ])
    ).toHaveLength(2);
  });

  it('labels each kind of worktree', () => {
    expect(worktreeAction({ orphan: true, taskDone: false })).toEqual({
      note: null,
      button: 'Delete',
    });
    expect(worktreeAction({ orphan: false, taskDone: true }).button).toBe('Remove worktree');
    const live = worktreeAction({ orphan: false, taskDone: false });
    expect(live.button).toBeNull();
    expect(live.note).toMatch(/once the task is done/);
  });

  it('words the dialog for a done task apart from orphans', () => {
    const done = deleteDialogText([{ orphan: false, taskDone: true }]);
    expect(done.title).toBe('Remove worktree');
    expect(done.description).toMatch(/branch stay/);
    expect(deleteDialogText([{ orphan: true, taskDone: false }]).title).toBe(
      'Delete orphan worktree'
    );
    expect(
      deleteDialogText([
        { orphan: true, taskDone: false },
        { orphan: true, taskDone: false },
      ]).title
    ).toBe('Delete 2 orphan worktrees');
  });

  it('summarises a cleanup', () => {
    expect(cleanupSummary(0, 0)).toBe('No orphan worktrees removed');
    expect(cleanupSummary(1, 0)).toBe('Removed 1 orphan worktree');
    expect(cleanupSummary(3, 1)).toBe('Removed 3 orphan worktrees; 1 could not be removed');
  });
});

describe('dirtyLabel', () => {
  it('covers clean, dirty and unknown', () => {
    expect(dirtyLabel(false)).toBe('Clean');
    expect(dirtyLabel(true)).toBe('Uncommitted changes');
    expect(dirtyLabel(null)).toBe('Unknown');
  });
});

describe('groupWorktrees', () => {
  const entry = (taskId: string, repo: string, isDirty: boolean | null) =>
    ({
      taskId,
      repo,
      path:
        repo === '.'
          ? `/p/.code-automata/worktrees/${taskId}`
          : `/w/.code-automata/worktrees/${taskId}/${repo}`,
      branchName: `code-automata/${taskId}`,
      mainRepo: '/w',
      mainBranch: 'main',
      isDirty,
      taskTitle: 'T',
      orphan: false,
      taskDone: true,
    }) as unknown as WorktreeEntry;

  it('shows a workspace task once, with every repository', () => {
    const groups = groupWorktrees([
      entry('t1', 'web', false),
      entry('t1', 'api', true),
      entry('t2', 'api', false),
    ]);
    expect(groups.map((g) => [g.taskId, g.repos, g.isDirty, g.path])).toEqual([
      ['t1', ['api', 'web'], true, '/w/.code-automata/worktrees/t1'],
      ['t2', ['api'], false, '/w/.code-automata/worktrees/t2'],
    ]);
    expect(
      groupWorktrees([entry('t1', 'api', false), entry('t1', 'web', null)])[0].isDirty
    ).toBeNull();
    // A known change wins over an unreadable one, so the page can still force the removal.
    expect(groupWorktrees([entry('t1', 'api', true), entry('t1', 'web', null)])[0].isDirty).toBe(
      true
    );
  });

  it('leaves a one-repository worktree as it is', () => {
    const [g] = groupWorktrees([entry('t3', '.', false)]);
    expect(g.path).toBe('/p/.code-automata/worktrees/t3');
    expect(g.repos).toEqual(['.']);
  });
});
