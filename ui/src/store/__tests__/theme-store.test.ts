import { describe, it, expect, beforeEach } from 'vitest';
import { useThemeStore } from '../theme-store';
import { getTheme } from '@/lib/themes/theme-config';

describe('theme-store', () => {
  beforeEach(() => {
    useThemeStore.setState({ currentTheme: 'dark', theme: getTheme('dark') });
  });

  it('setTheme("ocean") updates currentTheme and theme to ocean theme', () => {
    useThemeStore.getState().setTheme('ocean');
    const state = useThemeStore.getState();
    expect(state.currentTheme).toBe('ocean');
    expect(state.theme.name).toBe('ocean');
    expect(state.theme.displayName).toBe('Ocean');
    expect(state.theme).toBe(getTheme('ocean'));
  });

  it('setTheme("forest") updates currentTheme and theme to forest theme', () => {
    useThemeStore.getState().setTheme('forest');
    const state = useThemeStore.getState();
    expect(state.currentTheme).toBe('forest');
    expect(state.theme.name).toBe('forest');
    expect(state.theme.displayName).toBe('Forest');
    expect(state.theme).toBe(getTheme('forest'));
  });

  it('setTheme("sunset") updates currentTheme and theme to sunset theme', () => {
    useThemeStore.getState().setTheme('sunset');
    const state = useThemeStore.getState();
    expect(state.currentTheme).toBe('sunset');
    expect(state.theme.name).toBe('sunset');
    expect(state.theme.displayName).toBe('Sunset');
    expect(state.theme).toBe(getTheme('sunset'));
  });

  it('works with all six ThemeName values without code changes', () => {
    const names = ['dark', 'light', 'retro', 'ocean', 'forest', 'sunset'] as const;
    for (const name of names) {
      useThemeStore.getState().setTheme(name);
      const state = useThemeStore.getState();
      expect(state.currentTheme).toBe(name);
      expect(state.theme.name).toBe(name);
      expect(state.theme).toBe(getTheme(name));
    }
  });
});
