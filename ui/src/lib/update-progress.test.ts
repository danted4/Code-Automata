import { describe, expect, it } from 'vitest';
import { isCheckingForUpdates, updateProgressView } from './update-progress';

describe('updateProgressView', () => {
  it('shows the download against its size', () => {
    expect(
      updateProgressView({
        phase: 'downloading',
        version: '3.1.1',
        downloaded: 6.5 * 1024 * 1024,
        total: 15 * 1024 * 1024,
      })
    ).toEqual({
      title: 'Downloading Code-Automata 3.1.1',
      detail: '6.5 MB of 15 MB (43%)',
      percent: 43,
    });
  });

  it('pulses until the download reaches 1%, and never passes 100', () => {
    for (const total of [null, 15 * 1024 * 1024]) {
      expect(
        updateProgressView({ phase: 'downloading', version: '3.1.1', downloaded: 0, total })
      ).toEqual({ title: 'Downloading Code-Automata 3.1.1', detail: 'Connecting…', percent: null });
    }
    expect(
      updateProgressView({
        phase: 'downloading',
        version: '3.1.1',
        downloaded: 100 * 1024,
        total: 15 * 1024 * 1024,
      })
    ).toEqual({
      title: 'Downloading Code-Automata 3.1.1',
      detail: '100 KB of 15 MB',
      percent: null,
    });
    expect(
      updateProgressView({
        phase: 'downloading',
        version: '3.1.1',
        downloaded: 160 * 1024,
        total: 15 * 1024 * 1024,
      })?.percent
    ).toBe(1);
    expect(
      updateProgressView({ phase: 'downloading', version: '3.1.1', downloaded: 120, total: 100 })
        ?.percent
    ).toBe(100);
  });

  it('pulses when the size is unknown', () => {
    const view = updateProgressView({
      phase: 'downloading',
      version: '3.1.1',
      downloaded: 2048,
      total: null,
    });
    expect(view?.detail).toBe('2 KB downloaded');
    expect(view?.percent).toBeNull();
  });

  it('says it is installing, and hides on failure or before anything happens', () => {
    expect(updateProgressView({ phase: 'installing', version: '3.1.1' })).toEqual({
      title: 'Installing Code-Automata 3.1.1',
      detail: 'The app restarts in a moment.',
      percent: null,
    });
    expect(updateProgressView({ phase: 'failed', version: '3.1.1' })).toBeNull();
    expect(updateProgressView({ phase: 'cancelled', version: '3.1.1' })).toBeNull();
    expect(updateProgressView(null)).toBeNull();
    expect(updateProgressView({ phase: 'checking' })).toBeNull();
    expect(updateProgressView({ phase: 'idle' })).toBeNull();
  });
});

describe('isCheckingForUpdates', () => {
  it('is true only while a check runs', () => {
    expect(isCheckingForUpdates({ phase: 'checking' })).toBe(true);
    expect(isCheckingForUpdates({ phase: 'idle' })).toBe(false);
    expect(isCheckingForUpdates({ phase: 'installing', version: '3.1.2' })).toBe(false);
    expect(isCheckingForUpdates(null)).toBe(false);
  });
});
