/**
 * Electron API exposed via preload script.
 * Only available when running in Electron (desktop app).
 */

export type EditorId = 'cursor' | 'vscode';

export type AvailableEditor = {
  id: EditorId;
  label: string;
  /** When true, editor is installed and can be opened. Omitted or true from main. */
  available?: boolean;
};

export type OpenEditorResult = { success: boolean; error?: string };

export interface ElectronAPI {
  openFolderDialog: () => Promise<string | null>;
  getAvailableEditors: () => Promise<AvailableEditor[]>;
  pathExists: (path: string) => Promise<boolean>;
  openEditorAtPath: (worktreePath: string, editorId: EditorId) => Promise<OpenEditorResult>;
  openFolder: (worktreePath: string) => Promise<OpenEditorResult>;
}

declare global {
  interface Window {
    electron?: ElectronAPI;
  }
}
