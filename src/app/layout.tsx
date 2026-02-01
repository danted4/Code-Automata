import type { Metadata } from 'next';
import './globals.css';
import { ErrorBoundary } from '@/components/error-boundary';
import { Sidebar } from '@/components/layout/sidebar';
import { ThemeProvider } from '@/components/theme/theme-provider';
import { OpenProjectGate } from '@/components/project/open-project-gate';
import { Toaster } from '@/components/ui/sonner';

export const metadata: Metadata = {
  title: 'Code-Auto',
  description: 'Autonomous AI agents for developers',
  icons: {
    icon: [{ url: '/icon.png', type: 'image/png' }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className="antialiased flex"
        style={{ background: 'var(--color-background)', color: 'var(--color-foreground)' }}
      >
        <ErrorBoundary>
          <ThemeProvider>
            <OpenProjectGate>
              <Sidebar />
              <main className="flex-1 min-w-0 overflow-hidden pl-64">{children}</main>
              <Toaster />
            </OpenProjectGate>
          </ThemeProvider>
        </ErrorBoundary>
      </body>
    </html>
  );
}
