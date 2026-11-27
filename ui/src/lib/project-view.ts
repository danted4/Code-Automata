/** What the open-project dialog says about a folder it has opened before. */

import type { ProjectKind } from '@/lib/api/types/ProjectKind';

/** What a project folder was when last opened: a repository, or a workspace of N. */
export type ProjectInfo = { kind: ProjectKind; repos: number };

/** "workspace · 3 repositories", or "repository". */
export function projectLabel(info: ProjectInfo): string {
  if (info.kind === 'repo') return 'repository';
  return `workspace · ${info.repos} ${info.repos === 1 ? 'repository' : 'repositories'}`;
}
