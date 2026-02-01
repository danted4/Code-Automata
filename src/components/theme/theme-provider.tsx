'use client';

/**
 * Theme Provider
 *
 * Applies theme CSS variables to the document
 */

import { useEffect } from 'react';
import { useThemeStore } from '@/store/theme-store';
import { getTheme } from '@/lib/themes/theme-config';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { theme } = useThemeStore();
  const colors = theme?.colors ?? getTheme('dark').colors;

  useEffect(() => {
    const root = document.documentElement;

    // Apply CSS variables
    root.style.setProperty('--color-background', colors.background);
    root.style.setProperty('--color-foreground', colors.foreground);
    root.style.setProperty('--color-surface', colors.surface);
    root.style.setProperty('--color-surface-hover', colors.surfaceHover);
    root.style.setProperty('--color-border', colors.border);
    root.style.setProperty('--color-border-hover', colors.borderHover);
    root.style.setProperty('--color-text-primary', colors.textPrimary);
    root.style.setProperty('--color-text-secondary', colors.textSecondary);
    root.style.setProperty('--color-text-muted', colors.textMuted);
    root.style.setProperty('--color-primary', colors.primary);
    root.style.setProperty('--color-primary-hover', colors.primaryHover);
    root.style.setProperty('--color-primary-text', colors.primaryText);
    root.style.setProperty('--color-secondary', colors.secondary);
    root.style.setProperty('--color-secondary-hover', colors.secondaryHover);
    root.style.setProperty('--color-secondary-text', colors.secondaryText);
    root.style.setProperty('--color-destructive', colors.destructive);
    root.style.setProperty('--color-destructive-hover', colors.destructiveHover);
    root.style.setProperty('--color-destructive-text', colors.destructiveText);
    root.style.setProperty('--color-success', colors.success);
    root.style.setProperty('--color-warning', colors.warning);
    root.style.setProperty('--color-error', colors.error);
    root.style.setProperty('--color-info', colors.info);
    root.style.setProperty('--color-phase-discovery', colors.phaseDiscovery);
    root.style.setProperty('--color-phase-requirements', colors.phaseRequirements);
    root.style.setProperty('--color-phase-context', colors.phaseContext);
    root.style.setProperty('--color-phase-spec', colors.phaseSpec);
    root.style.setProperty('--color-phase-planning', colors.phasePlanning);
    root.style.setProperty('--color-phase-validate', colors.phaseValidate);
    root.style.setProperty('--color-status-pending', colors.statusPending);
    root.style.setProperty('--color-status-in-progress', colors.statusInProgress);
    root.style.setProperty('--color-status-completed', colors.statusCompleted);
    root.style.setProperty('--color-status-blocked', colors.statusBlocked);
    root.style.setProperty('--color-agent-active', colors.agentActive);
    root.style.setProperty('--color-terminal-background', colors.terminalBackground);
    root.style.setProperty('--color-terminal-text', colors.terminalText);
    root.style.setProperty('--color-sidebar-shadow', colors.sidebarShadow);
  }, [colors]);

  return <>{children}</>;
}
