import { createBrowserRouter, Link, Outlet } from 'react-router';
import { ErrorBoundary } from '@/components/error-boundary';
import { Sidebar } from '@/components/layout/sidebar';
import { OpenProjectGate } from '@/components/project/open-project-gate';
import { ThemeProvider } from '@/components/theme/theme-provider';
import { useProjectSync } from '@/store/project-sync';
import { Toaster } from '@/components/ui/sonner';
import { UpdateProgress } from '@/components/update-progress';
import BoardPage from '@/routes/board';
import SettingsPage from '@/routes/settings';
import WorktreesPage from '@/routes/worktrees';

function Layout() {
  useProjectSync();
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
        <UpdateProgress />
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
      { path: 'settings', element: <SettingsPage /> },
      { path: 'worktrees', element: <WorktreesPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
