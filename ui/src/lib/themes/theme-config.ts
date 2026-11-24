/**
 * Theme Configuration
 *
 * Defines available themes and their color palettes
 */

export type ThemeName = 'dark' | 'light' | 'retro' | 'ocean' | 'forest' | 'sunset';

export interface Theme {
  name: ThemeName;
  displayName: string;
  description: string;
  colors: {
    // Base colors
    background: string;
    foreground: string;

    // Surface colors (cards, panels)
    surface: string;
    surfaceHover: string;

    // Border colors
    border: string;
    borderHover: string;

    // Text colors
    textPrimary: string;
    textSecondary: string;
    textMuted: string;

    // Interactive elements
    primary: string;
    primaryHover: string;
    primaryText: string;

    secondary: string;
    secondaryHover: string;
    secondaryText: string;

    destructive: string;
    destructiveHover: string;
    destructiveText: string;

    // Status colors
    success: string;
    warning: string;
    error: string;
    info: string;

    // Kanban phase colors
    phaseDiscovery: string;
    phaseRequirements: string;
    phaseContext: string;
    phaseSpec: string;
    phasePlanning: string;
    phaseValidate: string;

    // Status badge colors
    statusPending: string;
    statusInProgress: string;
    statusCompleted: string;
    statusBlocked: string;

    // Agent/Terminal colors
    agentActive: string;
    terminalBackground: string;
    terminalText: string;

    /** Sidebar shadow (cast to the right) - theme-matched */
    sidebarShadow: string;
  };
}

export const themes: Record<ThemeName, Theme> = {
  dark: {
    name: 'dark',
    displayName: 'Modern Dark',
    description: 'Sleek dark theme with slate tones',
    colors: {
      background: '#0f172a',
      foreground: '#ffffff',

      surface: '#1e293b',
      surfaceHover: '#334155',

      border: '#334155',
      borderHover: '#475569',

      textPrimary: '#ffffff',
      textSecondary: '#cbd5e1',
      textMuted: '#94a3b8',

      primary: '#fbbf24',
      primaryHover: '#f59e0b',
      primaryText: '#000000',

      secondary: '#475569',
      secondaryHover: '#334155',
      secondaryText: '#ffffff',

      destructive: '#ef4444',
      destructiveHover: '#dc2626',
      destructiveText: '#ffffff',

      success: '#10b981',
      warning: '#f59e0b',
      error: '#ef4444',
      info: '#06b6d4',

      phaseDiscovery: '#8b5cf6',
      phaseRequirements: '#6366f1',
      phaseContext: '#3b82f6',
      phaseSpec: '#06b6d4',
      phasePlanning: '#10b981',
      phaseValidate: '#f59e0b',

      statusPending: '#6b7280',
      statusInProgress: '#3b82f6',
      statusCompleted: '#10b981',
      statusBlocked: '#ef4444',

      agentActive: '#06b6d4',
      terminalBackground: '#0f172a',
      terminalText: '#e2e8f0',

      sidebarShadow: 'rgba(0, 0, 0, 0.5)',
    },
  },

  light: {
    name: 'light',
    displayName: 'Light Mode',
    description: 'Clean and bright workspace',
    colors: {
      background: '#ffffff',
      foreground: '#0f172a',

      surface: '#f8fafc',
      surfaceHover: '#f1f5f9',

      border: '#e2e8f0',
      borderHover: '#cbd5e1',

      textPrimary: '#0f172a',
      textSecondary: '#475569',
      textMuted: '#64748b',

      primary: '#f59e0b',
      primaryHover: '#d97706',
      primaryText: '#ffffff',

      secondary: '#e2e8f0',
      secondaryHover: '#cbd5e1',
      secondaryText: '#0f172a',

      destructive: '#dc2626',
      destructiveHover: '#b91c1c',
      destructiveText: '#ffffff',

      success: '#059669',
      warning: '#d97706',
      error: '#dc2626',
      info: '#0891b2',

      phaseDiscovery: '#a78bfa',
      phaseRequirements: '#818cf8',
      phaseContext: '#60a5fa',
      phaseSpec: '#22d3ee',
      phasePlanning: '#34d399',
      phaseValidate: '#fbbf24',

      statusPending: '#9ca3af',
      statusInProgress: '#60a5fa',
      statusCompleted: '#34d399',
      statusBlocked: '#f87171',

      agentActive: '#0891b2',
      terminalBackground: '#f8fafc',
      terminalText: '#1e293b',

      sidebarShadow: 'rgba(0, 0, 0, 0.1)',
    },
  },

  retro: {
    name: 'retro',
    displayName: 'Retro Terminal',
    description: 'Classic CRT monitor aesthetic',
    colors: {
      background: '#000000',
      foreground: '#00ff00',

      surface: '#0a0a0a',
      surfaceHover: '#1a1a1a',

      border: '#00ff00',
      borderHover: '#00ff41',

      textPrimary: '#00ff00',
      textSecondary: '#00cc00',
      textMuted: '#008800',

      primary: '#ff00ff',
      primaryHover: '#ff00cc',
      primaryText: '#000000',

      secondary: '#1a1a1a',
      secondaryHover: '#2a2a2a',
      secondaryText: '#00ff00',

      destructive: '#ff0000',
      destructiveHover: '#cc0000',
      destructiveText: '#000000',

      success: '#00ff00',
      warning: '#ffff00',
      error: '#ff0000',
      info: '#00ffff',

      phaseDiscovery: '#ff00ff',
      phaseRequirements: '#ff00cc',
      phaseContext: '#cc00ff',
      phaseSpec: '#00ffff',
      phasePlanning: '#00ff00',
      phaseValidate: '#ffff00',

      statusPending: '#666666',
      statusInProgress: '#00ffff',
      statusCompleted: '#00ff00',
      statusBlocked: '#ff0000',

      agentActive: '#00ffff',
      terminalBackground: '#000000',
      terminalText: '#00ff00',

      sidebarShadow: 'rgba(0, 255, 0, 0.12)',
    },
  },

  ocean: {
    name: 'ocean',
    displayName: 'Ocean',
    description: 'Deep ocean blue and cyan palette',
    colors: {
      background: '#0c1929',
      foreground: '#f8fafc',

      surface: '#132f4c',
      surfaceHover: '#1e4976',

      border: '#1e4976',
      borderHover: '#2d5a87',

      textPrimary: '#f1f5f9',
      textSecondary: '#b8d4e8',
      textMuted: '#7ea3c2',

      primary: '#06b6d4',
      primaryHover: '#0891b2',
      primaryText: '#0c1929',

      secondary: '#1e4976',
      secondaryHover: '#2d5a87',
      secondaryText: '#e0f2fe',

      destructive: '#ef4444',
      destructiveHover: '#dc2626',
      destructiveText: '#ffffff',

      success: '#10b981',
      warning: '#f59e0b',
      error: '#ef4444',
      info: '#22d3ee',

      phaseDiscovery: '#818cf8',
      phaseRequirements: '#6366f1',
      phaseContext: '#3b82f6',
      phaseSpec: '#06b6d4',
      phasePlanning: '#14b8a6',
      phaseValidate: '#f59e0b',

      statusPending: '#64748b',
      statusInProgress: '#0ea5e9',
      statusCompleted: '#10b981',
      statusBlocked: '#ef4444',

      agentActive: '#22d3ee',
      terminalBackground: '#0c1929',
      terminalText: '#e0f2fe',

      sidebarShadow: 'rgba(12, 25, 41, 0.55)',
    },
  },

  forest: {
    name: 'forest',
    displayName: 'Forest',
    description: 'Dark green and slate base with emerald and teal',
    colors: {
      background: '#0f1d14',
      foreground: '#ecfdf5',

      surface: '#14532d',
      surfaceHover: '#166534',

      border: '#166534',
      borderHover: '#15803d',

      textPrimary: '#f0fdf4',
      textSecondary: '#a7f3d0',
      textMuted: '#6ee7b7',

      primary: '#10b981',
      primaryHover: '#059669',
      primaryText: '#022c22',

      secondary: '#14532d',
      secondaryHover: '#166534',
      secondaryText: '#d1fae5',

      destructive: '#ef4444',
      destructiveHover: '#dc2626',
      destructiveText: '#ffffff',

      success: '#10b981',
      warning: '#eab308',
      error: '#ef4444',
      info: '#14b8a6',

      phaseDiscovery: '#34d399',
      phaseRequirements: '#14b8a6',
      phaseContext: '#0d9488',
      phaseSpec: '#0d9488',
      phasePlanning: '#059669',
      phaseValidate: '#eab308',

      statusPending: '#64748b',
      statusInProgress: '#14b8a6',
      statusCompleted: '#10b981',
      statusBlocked: '#ef4444',

      agentActive: '#2dd4bf',
      terminalBackground: '#0f1d14',
      terminalText: '#d1fae5',

      sidebarShadow: 'rgba(15, 29, 20, 0.55)',
    },
  },

  sunset: {
    name: 'sunset',
    displayName: 'Sunset',
    description: 'Warm dark sunset palette with amber and coral',
    colors: {
      background: '#1c1614',
      foreground: '#fef3e2',

      surface: '#2d221c',
      surfaceHover: '#3d3028',

      border: '#4a3c32',
      borderHover: '#5c4a3d',

      textPrimary: '#fef3e2',
      textSecondary: '#e8d5c4',
      textMuted: '#b8a090',

      primary: '#f59e0b',
      primaryHover: '#d97706',
      primaryText: '#1c1614',

      secondary: '#3d3028',
      secondaryHover: '#4a3c32',
      secondaryText: '#fef3e2',

      destructive: '#ef4444',
      destructiveHover: '#dc2626',
      destructiveText: '#ffffff',

      success: '#10b981',
      warning: '#f59e0b',
      error: '#ef4444',
      info: '#0ea5e9',

      phaseDiscovery: '#d97706',
      phaseRequirements: '#ea580c',
      phaseContext: '#f97316',
      phaseSpec: '#fb923c',
      phasePlanning: '#10b981',
      phaseValidate: '#eab308',

      statusPending: '#78716c',
      statusInProgress: '#f59e0b',
      statusCompleted: '#10b981',
      statusBlocked: '#ef4444',

      agentActive: '#fb923c',
      terminalBackground: '#1c1614',
      terminalText: '#e8d5c4',

      sidebarShadow: 'rgba(28, 22, 20, 0.55)',
    },
  },
};

export function getTheme(name: ThemeName): Theme {
  return themes[name];
}

export function getAllThemes(): Theme[] {
  return Object.values(themes);
}
