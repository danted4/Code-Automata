/**
 * Electron Preload Script
 *
 * Exposes safe APIs to the renderer via contextBridge.
 * Used for native folder picker in Open Project modal.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  openFolderDialog: () => ipcRenderer.invoke('open-folder-dialog'),
  getAvailableEditors: () => ipcRenderer.invoke('review-locally:get-editors'),
  pathExists: (path) => ipcRenderer.invoke('review-locally:path-exists', { path }),
  openEditorAtPath: (worktreePath, editorId) =>
    ipcRenderer.invoke('review-locally:open-editor', { worktreePath, editorId }),
  openFolder: (worktreePath) =>
    ipcRenderer.invoke('review-locally:open-folder', { worktreePath }),
});
