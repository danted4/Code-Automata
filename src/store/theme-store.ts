/**
 * Theme Store
 *
 * Global state management for theme selection
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ThemeName, getTheme, Theme } from '@/lib/themes/theme-config';

interface ThemeStore {
  currentTheme: ThemeName;
  theme: Theme;
  setTheme: (theme: ThemeName) => void;
}

const validThemeNames: ThemeName[] = ['dark', 'light', 'retro', 'ocean', 'forest', 'sunset'];

function safeThemeName(name: unknown): ThemeName {
  return validThemeNames.includes(name as ThemeName) ? (name as ThemeName) : 'dark';
}

export const useThemeStore = create<ThemeStore>()(
  persist(
    (set) => ({
      currentTheme: 'dark',
      theme: getTheme('dark'),
      setTheme: (themeName: ThemeName) =>
        set({
          currentTheme: themeName,
          theme: getTheme(themeName),
        }),
    }),
    {
      name: 'code-auto-theme',
      partialize: (state) => ({ currentTheme: state.currentTheme }),
      merge: (persisted, current) => {
        const name = safeThemeName((persisted as { currentTheme?: unknown })?.currentTheme);
        return {
          ...current,
          currentTheme: name,
          theme: getTheme(name),
        };
      },
    }
  )
);
