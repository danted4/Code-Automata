/**
 * What the update panel shows while an accepted update downloads and installs (desktop app only).
 */

import type { UpdateEvent } from '@/lib/native';
import { formatBytes } from '@/lib/worktree-view';

export type UpdateProgressView = {
  title: string;
  detail: string;
  /**
   * 1 to 100; null (the bar pulses) until the download has reached 1%, when the size is unknown,
   * or when the step has no measure.
   */
  percent: number | null;
};

/**
 * The panel for an update event; null hides it (nothing accepted yet, or the update failed or was
 * dropped).
 */
export function updateProgressView(event: UpdateEvent | null): UpdateProgressView | null {
  if (!event) return null;
  switch (event.phase) {
    case 'downloading': {
      const { version, downloaded, total, attempt } = event;
      const title = `Downloading Code-Automata ${version}`;
      if (downloaded <= 0) {
        const detail = attempt > 1 ? 'The download stopped; trying again…' : 'Connecting…';
        return { title, detail, percent: null };
      }
      if (total === null || total <= 0) {
        return { title, detail: `${formatBytes(downloaded)} downloaded`, percent: null };
      }
      const percent = Math.min(100, Math.floor((downloaded / total) * 100));
      const sizes = `${formatBytes(downloaded)} of ${formatBytes(total)}`;
      // Below 1% the bar would sit still at nothing: keep it pulsing until it can move.
      if (percent < 1) return { title, detail: sizes, percent: null };
      return { title, detail: `${sizes} (${percent}%)`, percent };
    }
    case 'installing':
      return {
        title: `Installing Code-Automata ${event.version}`,
        detail: 'The app restarts in a moment.',
        percent: null,
      };
    case 'checking':
    case 'idle':
    case 'failed':
    case 'cancelled':
      return null;
  }
}

/** Whether the app is looking for a new version right now (at launch, or from Settings). */
export function isCheckingForUpdates(event: UpdateEvent | null): boolean {
  return event?.phase === 'checking';
}
