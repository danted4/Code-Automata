'use client';

/**
 * Theme Switcher Component
 *
 * Allows users to switch between available themes
 */

import { useThemeStore } from '@/store/theme-store';
import { getAllThemes, ThemeName } from '@/lib/themes/theme-config';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Palette } from 'lucide-react';

export function ThemeSwitcher() {
  const { currentTheme, theme, setTheme } = useThemeStore();
  const themes = getAllThemes();

  return (
    <div className="flex items-center gap-3">
      <Palette className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
      <Select value={currentTheme} onValueChange={(value) => setTheme(value as ThemeName)}>
        <SelectTrigger className="w-[180px]">
          <SelectValue>
            {theme.displayName}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {themes.map((theme) => (
            <SelectItem key={theme.name} value={theme.name}>
              <div className="flex flex-col">
                <span className="font-medium">{theme.displayName}</span>
                <span className="text-xs opacity-70">{theme.description}</span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
