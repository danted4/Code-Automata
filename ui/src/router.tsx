import { createBrowserRouter, Link, Outlet } from 'react-router';
import { ErrorBoundary } from '@/components/error-boundary';
import { Sidebar } from '@/components/layout/sidebar';
import { OpenProjectGate } from '@/components/project/open-project-gate';
import { ThemeProvider } from '@/components/theme/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import AgentsPage from '@/routes/agents';
import BoardPage from '@/routes/board';
import GitHubPage from '@/routes/github';
import MemoryPage from '@/routes/memory';
import SettingsPage from '@/routes/settings';
import TasksPage from '@/routes/tasks';
import WorktreesPage from '@/routes/worktrees';

function Layout() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <OpenProjectGate>
          <Sidebar />
          <main className="flex-1 min-w-0 overflow-hidden pl-64">
            <Outlet />
          </main>
          <Toaster />
        </OpenProjectGate>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

function NotFound() {
  return (
    <div className="p-8 space-y-2">
      <h1 className="text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>
        Page not found
      </h1>
      <Link to="/" className="text-sm underline" style={{ color: 'var(--color-primary)' }}>
        Back to the board
      </Link>
    </div>
  );
}

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <BoardPage /> },
      { path: 'agents', element: <AgentsPage /> },
      { path: 'tasks', element: <TasksPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'github', element: <GitHubPage /> },
      { path: 'worktrees', element: <WorktreesPage /> },
      { path: 'memory', element: <MemoryPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
