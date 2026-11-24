/**
 * Desktop-only actions: the folder picker, finding installed editors, opening a worktree.
 *
 * The Tauri shell implements this with its own commands (Phase 5). Until then, and whenever the
 * UI runs in a plain browser, `native` is null and the UI hides these actions.
 */

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
  getAvailableEditors: () => Promise<AvailableEditor[]>;
  pathExists: (path: string) => Promise<boolean>;
  openEditorAtPath: (
    worktreePath: string,
    editorId: EditorId,
    projectPath?: string | null
  ) => Promise<OpenEditorResult>;
  openFolder: (worktreePath: string) => Promise<OpenEditorResult>;
}

export const native: NativeApi | null = null;
