import { describe, expect, it } from 'vitest';
import type { Task } from '@/lib/api/types/Task';
import { mergeList } from './task-store';

function task(id: string, updatedAt: number, title = id): Task {
  return {
    schema: 1,
    id,
    title,
    createdAt: 0,
    updatedAt,
    phase: 'planning',
    agent: { provider: 'claude' },
    requirePlanApproval: false,
    planning: { stage: 'not_started' },
  };
}

describe('mergeList', () => {
  it('keeps the newer copy of each task', () => {
    const current = [task('a', 200, 'from event'), task('b', 50)];
    const listed = [task('a', 100, 'from list'), task('b', 60, 'b newer')];
    const merged = mergeList(current, listed, 150, new Map());
    expect(merged.find((t) => t.id === 'a')?.title).toBe('from event');
    expect(merged.find((t) => t.id === 'b')?.title).toBe('b newer');
  });

  it('keeps a task created after the read began and drops one deleted elsewhere', () => {
    const current = [task('new', 300), task('old', 10)];
    const merged = mergeList(current, [], 200, new Map());
    expect(merged.map((t) => t.id)).toEqual(['new']);
  });

  it('does not bring back a task removed after the read began', () => {
    const merged = mergeList([], [task('gone', 100)], 150, new Map([['gone', 160]]));
    expect(merged).toEqual([]);
    // Removed before the read: the list is newer, so it is back (recreated with that id).
    const back = mergeList([], [task('gone', 100)], 150, new Map([['gone', 120]]));
    expect(back.map((t) => t.id)).toEqual(['gone']);
  });
});
