import { describe, expect, it } from 'vitest';
import { native, tauriNative, updateCheckMessage } from './native';

function fakeInvoke(answers: Record<string, unknown>) {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const call = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push([command, args]);
    const answer = answers[command];
    if (answer instanceof Error) throw answer;
    return answer as T;
  };
  return { call, calls };
}

describe('native', () => {
  it('is null outside the desktop app', () => {
    expect(native).toBeNull();
  });

  it('maps each action to the app command and its argument names', async () => {
    const { call, calls } = fakeInvoke({
      pick_folder: '/repo',
      pick_file: '/home/me/.local/bin/claude',
      available_editors: [{ id: 'cursor', label: 'Cursor', available: true }],
      path_exists: true,
      open_in_editor: { success: true },
      reveal_folder: { success: true },
      get_app_settings: { schema: 1, checkUpdatesAtLaunch: true },
      set_app_settings: null,
      check_for_updates: 'up_to_date',
    });
    const api = tauriNative(call);
    expect(await api.openFolderDialog()).toBe('/repo');
    expect(await api.pickFile('Choose the claude file')).toBe('/home/me/.local/bin/claude');
    expect(await api.getAvailableEditors()).toEqual([
      { id: 'cursor', label: 'Cursor', available: true },
    ]);
    expect(await api.pathExists('/repo/wt')).toBe(true);
    expect(await api.openEditorAtPath('/repo/wt', 'vscode', '/repo')).toEqual({ success: true });
    expect(await api.openFolder('/repo/wt')).toEqual({ success: true });
    expect(await api.getAppSettings()).toEqual({ schema: 1, checkUpdatesAtLaunch: true });
    await api.setAppSettings({ schema: 1, checkUpdatesAtLaunch: false });
    expect(await api.checkForUpdates()).toBe('up_to_date');
    expect(calls).toEqual([
      ['pick_folder', undefined],
      ['pick_file', { title: 'Choose the claude file' }],
      ['available_editors', undefined],
      ['path_exists', { path: '/repo/wt' }],
      ['open_in_editor', { worktreePath: '/repo/wt', editorId: 'vscode' }],
      ['reveal_folder', { worktreePath: '/repo/wt' }],
      ['get_app_settings', undefined],
      ['set_app_settings', { settings: { schema: 1, checkUpdatesAtLaunch: false } }],
      ['check_for_updates', undefined],
    ]);
  });

  it('turns a refused open into a failed result instead of a rejection', async () => {
    const { call } = fakeInvoke({ open_in_editor: new Error('not allowed') });
    const result = await tauriNative(call).openEditorAtPath('/x', 'cursor');
    expect(result).toEqual({ success: false, error: 'not allowed' });
  });
});

describe('updateCheckMessage', () => {
  it('says what a check found unless the app asked', () => {
    expect(updateCheckMessage('up_to_date')).toBe("You're on the latest version");
    expect(updateCheckMessage('busy')).toBe('Already checking for updates');
    expect(updateCheckMessage('unavailable')).toBe('Updates are checked only in release builds');
    expect(updateCheckMessage('offered')).toBeNull();
  });
});
