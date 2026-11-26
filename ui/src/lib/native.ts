/**
 * Desktop-only actions: the folder and file pickers, finding installed editors, opening a worktree.
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
  };
}

const inDesktopApp = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const native: NativeApi | null = inDesktopApp ? tauriNative(invoke) : null;
