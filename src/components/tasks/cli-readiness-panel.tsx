'use client';

/**
 * CLI Readiness Panel
 *
 * Reserves fixed space and shows skeleton loader while API is in progress,
 * then displays the actual readiness content when loaded.
 */

import { ReactNode } from 'react';

export function SkeletonLines() {
  return (
    <div className="space-y-2 animate-pulse">
      <div
        className="h-3 rounded"
        style={{
          width: '70%',
          background: 'var(--color-surface-hover)',
        }}
      />
      <div
        className="h-3 rounded"
        style={{
          width: '50%',
          background: 'var(--color-surface-hover)',
        }}
      />
      <div
        className="h-3 rounded mt-2"
        style={{
          width: '60%',
          background: 'var(--color-surface-hover)',
        }}
      />
    </div>
  );
}

/** Placeholder that reserves space when CLI tool isn't amp/cursor or adapters are loading */
export function CliReadinessPlaceholder() {
  return (
    <div
      className="space-y-2 rounded-md border p-3 text-sm min-h-[110px]"
      style={{ borderColor: 'var(--color-border)' }}
    >
      <div className="flex items-center justify-between">
        <div
          className="h-4 w-32 rounded animate-pulse"
          style={{ background: 'var(--color-surface-hover)' }}
        />
        <div
          className="h-3 w-16 rounded animate-pulse"
          style={{ background: 'var(--color-surface-hover)' }}
        />
      </div>
      <SkeletonLines />
    </div>
  );
}

interface CliReadinessPanelProps {
  title: string;
  isLoading: boolean;
  statusLabel?: string;
  children: ReactNode;
}

export function CliReadinessPanel({
  title,
  isLoading,
  statusLabel,
  children,
}: CliReadinessPanelProps) {
  return (
    <div
      className="space-y-2 rounded-md border p-3 text-sm min-h-[110px]"
      style={{ borderColor: 'var(--color-border)' }}
    >
      <div className="flex items-center justify-between">
        <div className="font-medium">{title}</div>
        <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {isLoading ? (
            <span
              className="inline-block h-3 w-16 rounded animate-pulse"
              style={{ background: 'var(--color-surface-hover)' }}
            />
          ) : (
            (statusLabel ?? '—')
          )}
        </div>
      </div>
      {isLoading ? <SkeletonLines /> : children}
    </div>
  );
}
