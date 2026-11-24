/**
 * WCAG 2.1 contrast utilities for theme verification.
 * Used to assert textPrimary-on-background and primaryText-on-primary meet WCAG AA (4.5:1).
 */

/**
 * Parse hex color to RGB 0-255. Supports #rgb and #rrggbb.
 */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const cleaned = hex.replace(/^#/, '');
  if (cleaned.length === 3) {
    const r = parseInt(cleaned[0] + cleaned[0], 16);
    const g = parseInt(cleaned[1] + cleaned[1], 16);
    const b = parseInt(cleaned[2] + cleaned[2], 16);
    return { r, g, b };
  }
  if (cleaned.length === 6) {
    return {
      r: parseInt(cleaned.slice(0, 2), 16),
      g: parseInt(cleaned.slice(2, 4), 16),
      b: parseInt(cleaned.slice(4, 6), 16),
    };
  }
  throw new Error(`Invalid hex: ${hex}`);
}

/**
 * Relative luminance per WCAG 2.1 (sRGB).
 * https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */
function relativeLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/**
 * Contrast ratio per WCAG 2.1.
 * https://www.w3.org/TR/WCAG21/#contrast-minimum
 * Returns (L1 + 0.05) / (L2 + 0.05) where L1 is lighter, L2 is darker.
 */
export function contrastRatio(hex1: string, hex2: string): number {
  const rgb1 = hexToRgb(hex1);
  const rgb2 = hexToRgb(hex2);
  const L1 = relativeLuminance(rgb1.r, rgb1.g, rgb1.b);
  const L2 = relativeLuminance(rgb2.r, rgb2.g, rgb2.b);
  const [light, dark] = L1 >= L2 ? [L1, L2] : [L2, L1];
  return (light + 0.05) / (dark + 0.05);
}

/** WCAG AA minimum contrast for normal text. */
export const WCAG_AA_NORMAL = 4.5;

/** WCAG AA minimum contrast for large text. */
export const WCAG_AA_LARGE = 3;

/**
 * Asserts that foreground-on-background meets WCAG AA for normal text.
 * Returns the contrast ratio.
 */
export function assertWcagAaNormalText(foregroundHex: string, backgroundHex: string): number {
  const ratio = contrastRatio(foregroundHex, backgroundHex);
  if (ratio < WCAG_AA_NORMAL) {
    throw new Error(
      `Contrast ${ratio.toFixed(2)}:1 is below WCAG AA normal text (4.5:1). Foreground: ${foregroundHex}, Background: ${backgroundHex}`
    );
  }
  return ratio;
}
