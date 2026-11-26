import { describe, expect, it } from 'vitest';
import type { Preflight } from '@/lib/api/types/Preflight';
import { canChooseCli, cliPathError, offerCliChoice, sourceText } from './cli-path';

function preflight(over: Partial<Preflight> = {}): Preflight {
  return {
    provider: 'claude',
    binary: '/usr/local/bin/claude',
    source: 'path',
    chosen: null,
    version: '2.1.0',
    loggedIn: true,
    problem: null,
    ...over,
  };
}

describe('cli-path', () => {
  it('offers a choice when the CLI is missing or its login cannot be read', () => {
    expect(offerCliChoice(preflight({ binary: null, source: null, problem: 'not found' }))).toBe(
      true
    );
    // An old copy: found, but its login state could not be read.
    expect(offerCliChoice(preflight({ loggedIn: null, problem: 'could not read' }))).toBe(true);
    // Logging in fixes this one, not another file.
    expect(offerCliChoice(preflight({ loggedIn: false, problem: 'not logged in' }))).toBe(false);
    expect(offerCliChoice(preflight())).toBe(false);
    expect(offerCliChoice(null)).toBe(false);
    expect(offerCliChoice(preflight({ provider: 'mock', binary: null }))).toBe(false);
  });

  it('never chooses the mock agent file', () => {
    expect(canChooseCli('claude')).toBe(true);
    expect(canChooseCli('amp')).toBe(true);
    expect(canChooseCli('mock')).toBe(false);
  });

  it('accepts only full paths', () => {
    expect(cliPathError('')).toMatch(/Enter/);
    expect(cliPathError('   ')).toMatch(/Enter/);
    expect(cliPathError('claude')).toMatch(/full path/);
    expect(cliPathError('~/.local/bin/claude')).toMatch(/full path/);
    expect(cliPathError('/Users/me/.local/bin/claude')).toBeNull();
    expect(cliPathError(' /opt/bin/amp ')).toBeNull();
    expect(cliPathError('C:\\Users\\me\\.local\\bin\\claude.exe')).toBeNull();
    expect(cliPathError('\\\\server\\share\\claude.exe')).toBeNull();
  });

  it('describes where the CLI came from', () => {
    expect(sourceText('chosen')).toBe('chosen by you');
    expect(sourceText('installFolder')).toBe('install folder');
    expect(sourceText('path')).toBe('from PATH');
    expect(sourceText('configured')).toBeNull();
    expect(sourceText(null)).toBeNull();
  });
});
