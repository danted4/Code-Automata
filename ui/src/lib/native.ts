/**
 * Desktop-only actions: the folder and file pickers, finding installed editors, opening a worktree,
 * and the app's own settings and update check.
 *
 * In the desktop app these are its own commands (`crates/app/src/native.rs`), which check every
 * path against the projects the server has open. In a plain browser (`yarn dev`, the e2e suite)
 * `native` is null and the UI hides these actions.
 */

import { invoke } from '@tauri-apps/api/core';

export type EditorId = 'cursor' | 'vscode';

export type AvailableEditor = {
  id: EditorId;
  label: string;
  /** False when the editor is known but not installed. */
  available?: boolean;
};

export type OpenEditorResult = { success: boolean; error?: string };

/** The app's own settings for this computer (`app-settings.json`). */
export type AppSettings = { schema: number; checkUpdatesAtLaunch: boolean };

/** What "Check for updates" found (a newer version is offered in the app's own dialog). */
export type UpdateCheck = 'up_to_date' | 'offered' | 'busy' | 'unavailable';

export interface NativeApi {
  openFolderDialog: () => Promise<string | null>;
  /** A file picker (an agent's CLI); null when cancelled. */
  pickFile: (title: string) => Promise<string | null>;
  getAvailableEditors: () => Promise<AvailableEditor[]>;
  pathExists: (path: string) => Promise<boolean>;
  openEditorAtPath: (
    worktreePath: string,
    editorId: EditorId,
    projectPath?: string | null
  ) => Promise<OpenEditorResult>;
  openFolder: (worktreePath: string) => Promise<OpenEditorResult>;
  getAppSettings: () => Promise<AppSettings>;
  setAppSettings: (settings: AppSettings) => Promise<void>;
  checkForUpdates: () => Promise<UpdateCheck>;
}

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** The API over the app's commands. `call` is Tauri's `invoke`, or a fake in tests. */
export function tauriNative(call: Invoke): NativeApi {
  const open = async (command: string, args: Record<string, unknown>) => {
    try {
      return await call<OpenEditorResult>(command, args);
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
  return {
    openFolderDialog: () => call<string | null>('pick_folder'),
    pickFile: (title) => call<string | null>('pick_file', { title }),
    getAvailableEditors: () => call<AvailableEditor[]>('available_editors'),
    pathExists: (path) => call<boolean>('path_exists', { path }),
    // The app checks the folder against every open project, so the project is not sent.
    openEditorAtPath: (worktreePath, editorId) =>
      open('open_in_editor', { worktreePath, editorId }),
    openFolder: (worktreePath) => open('reveal_folder', { worktreePath }),
    getAppSettings: () => call<AppSettings>('get_app_settings'),
    setAppSettings: (settings) => call<void>('set_app_settings', { settings }),
    checkForUpdates: () => call<UpdateCheck>('check_for_updates'),
  };
}

/** What to tell the user after "Check for updates". Null when the app's dialog said it. */
export function updateCheckMessage(result: UpdateCheck): string | null {
  switch (result) {
    case 'up_to_date':
      return "You're on the latest version";
    case 'busy':
      return 'Already checking for updates';
    case 'unavailable':
      return 'Updates are checked only in release builds';
    case 'offered':
      return null;
  }
}

const inDesktopApp = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const native: NativeApi | null = inDesktopApp ? tauriNative(invoke) : null;
