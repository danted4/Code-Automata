'use client';

/**
 * Sidebar Navigation
 *
 * Left sidebar with project navigation and tools (matching Code-Auto)
 */

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  Terminal,
  ListTodo,
  Settings,
  GitBranch,
  GithubIcon,
  Brain,
  Plus
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NewTaskModal } from '@/components/tasks/new-task-modal';
import { ThemeSwitcher } from '@/components/theme/theme-switcher';

const projectLinks = [
  { href: '/', label: 'Kanban Board', icon: LayoutDashboard },
  { href: '/agents', label: 'Agent Terminals', icon: Terminal },
  { href: '/tasks', label: 'Task List', icon: ListTodo },
  { href: '/settings', label: 'Settings', icon: Settings },
];

const toolLinks = [
  { href: '/github', label: 'GitHub Issues', icon: GithubIcon },
  { href: '/worktrees', label: 'Git Worktrees', icon: GitBranch },
  { href: '/memory', label: 'Memory/Context', icon: Brain },
];

export function Sidebar() {
  const pathname = usePathname();
  const [isNewTaskModalOpen, setIsNewTaskModalOpen] = useState(false);

  return (
    <>
      <aside data-testid="sidebar" className="w-64 flex flex-col h-screen" style={{ background: 'var(--color-surface)', color: 'var(--color-foreground)' }}>
      {/* Header */}
      <div data-testid="sidebar-header" className="p-4 border-b" style={{ borderColor: 'var(--color-border)' }}>
        <h1 className="text-lg font-bold" style={{ color: 'var(--color-text-primary)' }}>Code-Auto</h1>
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Autonomous AI agents</p>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto">
        {/* Project Section */}
        <div data-testid="project-section" className="p-3">
          <h2 className="text-xs font-semibold uppercase mb-2 px-2" style={{ color: 'var(--color-text-muted)' }}>
            Project
          </h2>
          <div className="space-y-1">
            {projectLinks.map((link) => {
              const Icon = link.icon;
              const isActive = pathname === link.href;

              return (
                <Link
                  key={link.href}
                  href={link.href}
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
          <h2 className="text-xs font-semibold uppercase mb-2 px-2" style={{ color: 'var(--color-text-muted)' }}>
            Tools
          </h2>
          <div className="space-y-1">
            {toolLinks.map((link) => {
              const Icon = link.icon;
              const isActive = pathname === link.href;

              return (
                <Link
                  key={link.href}
                  href={link.href}
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
                  <Icon className="w-4 h-4" />
                  <span>{link.label}</span>
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
          <h3 className="text-xs font-semibold uppercase mb-3" style={{ color: 'var(--color-text-muted)' }}>Theme</h3>
          <ThemeSwitcher />
        </div>

        {/* New Task Button */}
        <div className="p-4">
          <Button
            data-testid="new-task-button"
            onClick={() => setIsNewTaskModalOpen(true)}
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
    </aside>

    {/* New Task Modal */}
    <NewTaskModal
      open={isNewTaskModalOpen}
      onOpenChange={setIsNewTaskModalOpen}
    />
  </>
  );
}
