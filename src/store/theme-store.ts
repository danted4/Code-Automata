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
    }
  )
);
