/**
 * Rules behind choosing an agent's CLI file by hand: when to offer it, what a typed path must look
 * like before it is sent, and how a found CLI's origin is described. The server checks the file
 * itself (exists, executable, answers `--version`).
 */

import type { BinarySource } from '@/lib/api/types/BinarySource';
import type { Preflight } from '@/lib/api/types/Preflight';
import type { Provider } from '@/lib/api/types/Provider';

/** Every agent but the scripted mock can have its file chosen. */
export function canChooseCli(provider: Provider): boolean {
  return provider !== 'mock';
}

/**
 * Offer to choose the file when the CLI was not found, or was found but its login could not be
 * read (often an old copy left behind on PATH). Not for "not logged in": that is fixed by logging
 * in, not by another file.
 */
export function offerCliChoice(p: Preflight | null): boolean {
  if (!p || !canChooseCli(p.provider)) return false;
  return p.binary === null || p.loggedIn === null;
}

/** Why a typed path cannot be sent yet, or null. */
export function cliPathError(text: string): string | null {
  const path = text.trim();
  if (!path) return 'Enter the full path to the file.';
  const absolute = path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
  if (!absolute) return 'Give the full path, starting from the root of the disk.';
  return null;
}

/** How the CLI was found, as shown after its path. */
export function sourceText(source: BinarySource | null): string | null {
  switch (source) {
    case 'chosen':
      return 'chosen by you';
    case 'installFolder':
      return 'install folder';
    case 'path':
      return 'from PATH';
    case 'configured':
    case null:
      return null;
  }
}
