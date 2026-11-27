import { describe, expect, it } from 'vitest';
import { projectLabel } from './project-view';

describe('projectLabel', () => {
  it('names a repository or counts a workspace', () => {
    expect(projectLabel({ kind: 'repo', repos: 1 })).toBe('repository');
    expect(projectLabel({ kind: 'workspace', repos: 1 })).toBe('workspace · 1 repository');
    expect(projectLabel({ kind: 'workspace', repos: 3 })).toBe('workspace · 3 repositories');
  });
});
