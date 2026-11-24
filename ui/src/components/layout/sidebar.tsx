/**
 * Sidebar Navigation
 *
 * Left sidebar with project navigation and tools (matching Code-Automata)
 */

import { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router';
import { LayoutDashboard, Settings, GitBranch, Plus, FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { NewTaskModal } from '@/components/tasks/new-task-modal';
import { OpenProjectModal } from '@/components/project/open-project-modal';
import { ThemeSwitcher } from '@/components/theme/theme-switcher';
import { useProjectStore } from '@/store/project-store';
import { api } from '@/lib/api';
import { useTaskStore } from '@/store/task-store';

/** Fetches worktree count for the current project. Refetches when projectPath or worktreeRefreshKey changes. */
function useWorktreeCount(): number {
  const projectPath = useProjectStore((s) => s.projectPath);
  const worktreeRefreshKey = useProjectStore((s) => s.worktreeRefreshKey);
  // A task gets its worktree when planning starts and loses it when deleted; a done task's can be
  // removed, and reopening the task (leaving Done) brings it back.
  const tasksWithWorktrees = useTaskStore((s) => s.tasks.filter((t) => t.baseCommit).length);
  const doneTasks = useTaskStore((s) => s.tasks.filter((t) => t.phase === 'done').length);
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!projectPath) {
      setCount(0);
      return;
    }

    let cancelled = false;

    api.worktrees
      .list()
      .then((list) => {
        if (!cancelled) setCount(list.length);
      })
      .catch(() => {
        if (!cancelled) setCount(0);
      });

    return () => {
      cancelled = true;
    };
  }, [projectPath, worktreeRefreshKey, tasksWithWorktrees, doneTasks]);

  return count;
}

const projectLinks = [
  { href: '/', label: 'Kanban Board', icon: LayoutDashboard },
  { href: '/settings', label: 'Settings', icon: Settings },
];

const toolLinks = [{ href: '/worktrees', label: 'Git Worktrees', icon: GitBranch }];

export function Sidebar() {
  const { pathname } = useLocation();
  const [isNewTaskModalOpen, setIsNewTaskModalOpen] = useState(false);
  const [isOpenProjectModalOpen, setIsOpenProjectModalOpen] = useState(false);
  const projectPath = useProjectStore((s) => s.projectPath);
  const worktreeCount = useWorktreeCount();

  return (
    <>
      <aside
        data-testid="sidebar"
        className="fixed left-0 top-0 bottom-0 w-64 flex flex-col h-screen z-20"
        style={{
          background: 'var(--color-surface)',
          color: 'var(--color-foreground)',
        }}
      >
        {/* Header */}
        <div
          data-testid="sidebar-header"
          className="p-4 border-b"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <h1
            className="text-lg font-bold flex items-baseline gap-1.5 flex-wrap"
            style={{ color: 'var(--color-text-primary)' }}
          >
            Code-Automata
            <span
              data-testid="sidebar-version"
              className="text-xs font-normal"
              style={{ color: 'var(--color-text-muted)' }}
            >
              v{__APP_VERSION__}
            </span>
          </h1>
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            Autonomous AI agents
          </p>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto">
          {/* Project Section */}
          <div data-testid="project-section" className="p-3">
            <div className="flex items-center justify-between mb-2 px-2">
              <h2
                className="text-xs font-semibold uppercase"
                style={{ color: 'var(--color-text-muted)' }}
              >
                Project
              </h2>
              <button
                type="button"
                onClick={() => setIsOpenProjectModalOpen(true)}
                className="p-1 rounded hover:opacity-80"
                title="Open Project"
              >
                <FolderOpen className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
              </button>
            </div>
            {projectPath && (
              <p
                className="text-xs px-2 mb-2 truncate"
                style={{ color: 'var(--color-text-muted)' }}
                title={projectPath}
              >
                {projectPath.split(/[/\\]/).pop() || projectPath}
              </p>
            )}
            <div className="space-y-1">
              {projectLinks.map((link) => {
                const Icon = link.icon;
                const isActive = pathname === link.href;

                return (
                  <Link
                    key={link.href}
                    to={link.href}
                    data-testid={`nav-${link.label.toLowerCase().replace(/\s+/g, '-')}`}
                    className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors"
                    style={{
                      background: isActive ? 'var(--color-background)' : 'transparent',
                      color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                    }}
                    onMouseEnter={(e) => {
                      if (!isActive) {
                        e.currentTarget.style.background = 'var(--color-background)';
                        e.currentTarget.style.color = 'var(--color-text-primary)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive) {
                        e.currentTarget.style.background = 'transparent';
                        e.currentTarget.style.color = 'var(--color-text-secondary)';
                      }
                    }}
                  >
                    <Icon className="w-4 h-4" />
                    <span>{link.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>

          {/* Tools Section */}
          <div data-testid="tools-section" className="p-3">
            <h2
              className="text-xs font-semibold uppercase mb-2 px-2"
              style={{ color: 'var(--color-text-muted)' }}
            >
              Tools
            </h2>
            <div className="space-y-1">
              {toolLinks.map((link) => {
                const Icon = link.icon;
                const isActive = pathname === link.href;
                const showWorktreeBadge = link.href === '/worktrees' && worktreeCount > 0;

                return (
                  <Link
                    key={link.href}
                    to={link.href}
                    data-testid={`nav-${link.label.toLowerCase().replace(/\s+/g, '-').replace('/', '-')}`}
                    className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors"
                    style={{
                      background: isActive ? 'var(--color-background)' : 'transparent',
                      color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                    }}
                    onMouseEnter={(e) => {
                      if (!isActive) {
                        e.currentTarget.style.background = 'var(--color-background)';
                        e.currentTarget.style.color = 'var(--color-text-primary)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive) {
                        e.currentTarget.style.background = 'transparent';
                        e.currentTarget.style.color = 'var(--color-text-secondary)';
                      }
                    }}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span className="min-w-0 flex-1">{link.label}</span>
                    {showWorktreeBadge && (
                      <Badge
                        data-testid="sidebar-worktree-count"
                        variant="secondary"
                        className="shrink-0 min-w-[1.25rem] justify-center px-1.5 py-0 text-xs"
                        style={{
                          background: 'var(--color-primary)',
                          color: 'var(--color-primary-text)',
                          border: 'none',
                        }}
                        aria-label={`${worktreeCount} worktrees`}
                      >
                        {worktreeCount}
                      </Badge>
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        </nav>

        {/* Footer */}
        <div className="border-t" style={{ borderColor: 'var(--color-border)' }}>
          {/* Theme Switcher */}
          <div className="p-4 border-b" style={{ borderColor: 'var(--color-border)' }}>
            <h3
              className="text-xs font-semibold uppercase mb-3"
              style={{ color: 'var(--color-text-muted)' }}
            >
              Theme
            </h3>
            <ThemeSwitcher />
          </div>

          {/* New Task Button */}
          <div className="p-4">
            <Button
              data-testid="new-task-button"
              onClick={() => {
                if (!projectPath) {
                  setIsOpenProjectModalOpen(true);
                } else {
                  setIsNewTaskModalOpen(true);
                }
              }}
              className="w-full font-medium"
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
              <Plus className="w-4 h-4 mr-2" />
              New Task
            </Button>
          </div>
        </div>

        {/* Soft shadow - gradient overlays content area only, no hard edge on sidebar */}
        <div
          className="absolute top-0 bottom-0 pointer-events-none"
          style={{
            left: '100%',
            width: 24,
            background:
              'linear-gradient(to right, rgba(0,0,0,0.18) 0%, rgba(0,0,0,0.06) 50%, transparent 100%)',
          }}
          aria-hidden
        />
      </aside>

      {/* New Task Modal */}
      <NewTaskModal open={isNewTaskModalOpen} onOpenChange={setIsNewTaskModalOpen} />

      {/* Open Project Modal */}
      <OpenProjectModal open={isOpenProjectModalOpen} onOpenChange={setIsOpenProjectModalOpen} />
    </>
  );
}
