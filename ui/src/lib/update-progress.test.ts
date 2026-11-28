import { describe, expect, it } from 'vitest';
import { updateProgressView } from './update-progress';

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

  it('starts at zero and never passes 100', () => {
    expect(
      updateProgressView({ phase: 'downloading', version: '3.1.1', downloaded: 0, total: null })
    ).toEqual({
      title: 'Downloading Code-Automata 3.1.1',
      detail: '0 B downloaded',
      percent: null,
    });
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
    expect(updateProgressView(null)).toBeNull();
  });
});
