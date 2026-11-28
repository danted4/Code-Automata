/**
 * Desktop app only: after "Install and restart", a panel over the app with the download's
 * progress, then that it is installing. It cannot be closed; the app restarts when it is done,
 * and a failure is explained in the app's own dialog (the panel then goes away). While it shows,
 * the app under it is inert, so neither the mouse nor the keyboard reaches it.
 */

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Download } from 'lucide-react';
import { native } from '@/lib/native';
import { updateProgressView } from '@/lib/update-progress';
import { useUpdateStore } from '@/store/update-store';

export function UpdateProgress() {
  const event = useUpdateStore((s) => s.event);

  useEffect(() => {
    native?.watchUpdates(useUpdateStore.getState().set).catch((e: unknown) => {
      // Without it the panel and Settings never hear about updates; the update itself still works.
      console.warn('Update progress is unavailable:', e);
    });
  }, []);

  const view = updateProgressView(event);
  const showing = view !== null;

  useEffect(() => {
    const root = document.getElementById('root');
    if (!root || !showing) return;
    root.inert = true;
    return () => {
      root.inert = false;
    };
  }, [showing]);

  if (!view) return null;
  // Outside #root, which is inert meanwhile.
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
      data-testid="update-progress"
    >
      <div
        role="status"
        aria-live="polite"
        className="w-full max-w-md space-y-3 rounded-lg border p-6 shadow-lg"
        style={{
          background: 'var(--color-surface)',
          borderColor: 'var(--color-border)',
          color: 'var(--color-text-primary)',
        }}
      >
        <div className="flex items-center gap-2 font-semibold">
          <Download className="w-5 h-5" style={{ color: 'var(--color-primary)' }} />
          {view.title}
        </div>
        <div
          className="relative h-2 w-full overflow-hidden rounded-full"
          style={{ background: 'var(--color-border)' }}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={view.percent ?? undefined}
        >
          {view.percent === null ? (
            <div
              className="update-bar-indeterminate absolute inset-y-0 left-0 rounded-full"
              style={{ background: 'var(--color-primary)' }}
            />
          ) : (
            <div
              className="h-full rounded-full transition-[width] duration-300 ease-out"
              style={{ background: 'var(--color-primary)', width: `${view.percent}%` }}
            />
          )}
        </div>
        <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          {view.detail}
        </p>
      </div>
    </div>,
    document.body
  );
}
