import { describe, it, expect } from 'vitest';
import { getTheme, getAllThemes, themes, type Theme, type ThemeName } from '../theme-config';
import { contrastRatio, assertWcagAaNormalText, WCAG_AA_NORMAL } from '../wcag-contrast';

const REQUIRED_COLOR_KEYS = [
  'background',
  'foreground',
  'surface',
  'surfaceHover',
  'border',
  'borderHover',
  'textPrimary',
  'textSecondary',
  'textMuted',
  'primary',
  'primaryHover',
  'primaryText',
  'secondary',
  'secondaryHover',
  'secondaryText',
  'destructive',
  'destructiveHover',
  'destructiveText',
  'success',
  'warning',
  'error',
  'info',
  'phaseDiscovery',
  'phaseRequirements',
  'phaseContext',
  'phaseSpec',
  'phasePlanning',
  'phaseValidate',
  'statusPending',
  'statusInProgress',
  'statusCompleted',
  'statusBlocked',
  'agentActive',
  'terminalBackground',
  'terminalText',
  'sidebarShadow',
] as const;

function assertThemeShape(theme: Theme, name: ThemeName) {
  expect(theme).toBeDefined();
  expect(theme.name).toBe(name);
  expect(theme.displayName).toBeTypeOf('string');
  expect(theme.description).toBeTypeOf('string');
  expect(theme.colors).toBeDefined();
  for (const key of REQUIRED_COLOR_KEYS) {
    expect(theme.colors[key], `theme.colors.${key}`).toBeDefined();
    expect(theme.colors[key]).toBeTypeOf('string');
  }
}

describe('theme-config', () => {
  describe('getTheme', () => {
    it("returns correct theme object for 'ocean'", () => {
      const ocean = getTheme('ocean');
      assertThemeShape(ocean, 'ocean');
      expect(ocean.displayName).toBe('Ocean');
      expect(ocean.description).toContain('Deep ocean blue');
      expect(ocean.colors.background).toBe('#0c1929');
      expect(ocean.colors.primary).toBe('#06b6d4');
      expect(ocean.colors.textPrimary).toBe('#f1f5f9');
      expect(ocean).toBe(themes.ocean);
    });

    it("returns correct theme object for 'forest'", () => {
      const forest = getTheme('forest');
      assertThemeShape(forest, 'forest');
      expect(forest.displayName).toBe('Forest');
      expect(forest.description).toContain('Dark green');
      expect(forest.colors.background).toBe('#0f1d14');
      expect(forest.colors.primary).toBe('#10b981');
      expect(forest.colors.textPrimary).toBe('#f0fdf4');
      expect(forest).toBe(themes.forest);
    });

    it("returns correct theme object for 'sunset'", () => {
      const sunset = getTheme('sunset');
      assertThemeShape(sunset, 'sunset');
      expect(sunset.displayName).toBe('Sunset');
      expect(sunset.description).toContain('Warm dark');
      expect(sunset.colors.background).toBe('#1c1614');
      expect(sunset.colors.primary).toBe('#f59e0b');
      expect(sunset.colors.textPrimary).toBe('#fef3e2');
      expect(sunset).toBe(themes.sunset);
    });

    it('returns correct theme for all ThemeName values', () => {
      const names: ThemeName[] = ['dark', 'light', 'retro', 'ocean', 'forest', 'sunset'];
      for (const name of names) {
        const theme = getTheme(name);
        assertThemeShape(theme, name);
        expect(theme).toBe(themes[name]);
      }
    });
  });

  describe('getAllThemes', () => {
    it('returns six themes', () => {
      const all = getAllThemes();
      expect(all).toHaveLength(6);
    });

    it('returns an array of Theme objects with all six theme names', () => {
      const all = getAllThemes();
      const names = all.map((t) => t.name).sort();
      expect(names).toEqual(['dark', 'forest', 'light', 'ocean', 'retro', 'sunset']);
    });

    it('each theme has full Theme shape', () => {
      const all = getAllThemes();
      for (const theme of all) {
        assertThemeShape(theme, theme.name);
      }
    });

    it('returns same theme instances as getTheme for each name', () => {
      const all = getAllThemes();
      for (const theme of all) {
        expect(getTheme(theme.name)).toBe(theme);
      }
    });
  });

  describe('WCAG AA contrast (Ocean, Forest, Sunset)', () => {
    const wcagThemes: ThemeName[] = ['ocean', 'forest', 'sunset'];

    it('textPrimary-on-background meets WCAG AA (4.5:1) for Ocean, Forest, Sunset', () => {
      for (const name of wcagThemes) {
        const theme = getTheme(name);
        const ratio = assertWcagAaNormalText(theme.colors.textPrimary, theme.colors.background);
        expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
      }
    });

    it('primaryText-on-primary meets WCAG AA (4.5:1) for Ocean, Forest, Sunset', () => {
      for (const name of wcagThemes) {
        const theme = getTheme(name);
        const ratio = assertWcagAaNormalText(theme.colors.primaryText, theme.colors.primary);
        expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
      }
    });

    it('reports exact contrast ratios for spot-check documentation', () => {
      const results: { theme: ThemeName; pair: string; ratio: number }[] = [];
      for (const name of wcagThemes) {
        const theme = getTheme(name);
        results.push({
          theme: name,
          pair: 'textPrimary-on-background',
          ratio: contrastRatio(theme.colors.textPrimary, theme.colors.background),
        });
        results.push({
          theme: name,
          pair: 'primaryText-on-primary',
          ratio: contrastRatio(theme.colors.primaryText, theme.colors.primary),
        });
      }
      for (const r of results) {
        expect(r.ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
      }
      // Sanity: ratios are in expected range (e.g. not absurdly high)
      expect(results.every((r) => r.ratio >= 4.5 && r.ratio <= 21)).toBe(true);
    });
  });
});
