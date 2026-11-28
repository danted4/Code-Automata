/**
 * What the update panel shows while an accepted update downloads and installs (desktop app only).
 */

import type { UpdateEvent } from '@/lib/native';
import { formatBytes } from '@/lib/worktree-view';

export type UpdateProgressView = {
  title: string;
  detail: string;
  /** 0 to 100; null when the size is unknown or the step has no measure (the bar then pulses). */
  percent: number | null;
};

/** The panel for an update event; null hides it (none yet, or the update failed or was dropped). */
export function updateProgressView(event: UpdateEvent | null): UpdateProgressView | null {
  if (!event) return null;
  switch (event.phase) {
    case 'downloading': {
      const { version, downloaded, total } = event;
      const title = `Downloading Code-Automata ${version}`;
      if (total === null || total <= 0) {
        return { title, detail: `${formatBytes(downloaded)} downloaded`, percent: null };
      }
      const percent = Math.min(100, Math.floor((downloaded / total) * 100));
      return {
        title,
        detail: `${formatBytes(downloaded)} of ${formatBytes(total)} (${percent}%)`,
        percent,
      };
    }
    case 'installing':
      return {
        title: `Installing Code-Automata ${event.version}`,
        detail: 'The app restarts in a moment.',
        percent: null,
      };
    case 'failed':
    case 'cancelled':
      return null;
  }
}
