/**
 * Electron Main Process
 *
 * Creates the app window and loads the Next.js app.
 * Exposes native APIs (e.g. folder picker) via preload.
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  nativeImage,
  nativeTheme,
  shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync, spawn } = require('child_process');

const isDev = process.env.NODE_ENV !== 'production';
const PORT = process.env.PORT || 3000;
const URL = isDev ? `http://localhost:${PORT}` : `http://localhost:${PORT}`;

let mainWindow = null;

function getIconPath() {
  const base = path.join(app.getAppPath(), 'public');
  const useDark = nativeTheme.shouldUseDarkColors;
  const dockIcon = useDark ? 'code-auto-dock.png' : 'code-auto-dock-light.png';
  const fallbackIcon = useDark ? 'code-auto-dark.png' : 'code-auto-light.png';
  const dockPath = path.join(base, dockIcon);
  const fallbackPath = path.join(base, fallbackIcon);
  if (fs.existsSync(dockPath)) return dockPath;
  if (fs.existsSync(fallbackPath)) return fallbackPath;
  return path.resolve(__dirname, '..', 'public', fallbackIcon);
}

function createWindow() {
  const iconPath = getIconPath();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(URL);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const CURSOR_APP_PATH = '/Applications/Cursor.app';
const VSCODE_APP_PATH = '/Applications/Visual Studio Code.app';

/**
 * Check if a CLI command is available (e.g. `cursor`, `code`).
 * @param {string} cmd - Command name
 * @returns {boolean}
 */
function isCliAvailable(cmd) {
  try {
    execSync(`which ${cmd}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect available editors (Cursor, VS Code).
 * @returns {{ id: 'cursor'|'vscode', label: string, available: boolean }[]}
 */
function getDetectedEditors() {
  const isDarwin = process.platform === 'darwin';

  const cursorCli = isCliAvailable('cursor');
  const cursorApp = isDarwin && fs.existsSync(CURSOR_APP_PATH);
  const cursorAvailable = cursorCli || cursorApp;

  const vscodeCli = isCliAvailable('code');
  const vscodeApp = isDarwin && fs.existsSync(VSCODE_APP_PATH);
  const vscodeAvailable = vscodeCli || vscodeApp;

  return [
    { id: 'cursor', label: 'Cursor', available: cursorAvailable },
    { id: 'vscode', label: 'VS Code', available: vscodeAvailable },
  ];
}

// Open folder dialog - returns selected path or null if cancelled
ipcMain.handle('open-folder-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow || undefined, {
    properties: ['openDirectory'],
    title: 'Select Project Directory',
  });

  if (result.canceled || !result.filePaths?.length) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle('review-locally:get-editors', async () => {
  return getDetectedEditors();
});

/**
 * Check if a path exists and is a directory (for worktree before opening).
 * @param {{ path: string }} payload
 * @returns {Promise<boolean>}
 */
ipcMain.handle('review-locally:path-exists', async (_event, payload) => {
  const p = payload?.path;
  if (typeof p !== 'string' || !p.trim()) return false;
  try {
    const resolved = path.resolve(p.trim());
    return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
  } catch {
    return false;
  }
});

/**
 * Open worktree folder in the system file manager (Finder, Explorer, etc.).
 * @param {{ worktreePath: string }} payload
 * @returns {{ success: boolean, error?: string }}
 */
ipcMain.handle('review-locally:open-folder', async (_event, payload) => {
  const { worktreePath } = payload ?? {};
  if (typeof worktreePath !== 'string' || !worktreePath.trim()) {
    return { success: false, error: 'worktreePath is required and must be a non-empty string' };
  }

  let resolvedPath;
  try {
    resolvedPath = path.resolve(worktreePath.trim());
  } catch {
    return { success: false, error: 'Invalid worktree path' };
  }

  if (!fs.existsSync(resolvedPath)) {
    return { success: false, error: `Worktree not found at ${resolvedPath}` };
  }

  let stat;
  try {
    stat = fs.statSync(resolvedPath);
  } catch (err) {
    return { success: false, error: err?.message || 'Failed to access path' };
  }

  if (!stat.isDirectory()) {
    return { success: false, error: 'Path is not a directory' };
  }

  let realPath;
  try {
    realPath = fs.realpathSync(resolvedPath);
  } catch (err) {
    return { success: false, error: err?.message || 'Failed to resolve path' };
  }

  try {
    const result = await shell.openPath(realPath);
    if (result === '') {
      return { success: true };
    }
    return { success: false, error: result };
  } catch (err) {
    return { success: false, error: err?.message || 'Failed to open folder' };
  }
});

/**
 * Check that a resolved absolute path is under at least one safe base (user home or optional project path).
 * @param {string} resolvedPath - Absolute path (realpath)
 * @param {string} [projectPath] - Optional project root; if provided, path may be under this instead of home
 * @returns {boolean}
 */
function isPathUnderSafeBase(resolvedPath, projectPath) {
  const home = os.homedir();
  const homeReal = fs.realpathSync.native ? fs.realpathSync.native(home) : fs.realpathSync(home);
  if (resolvedPath === homeReal || resolvedPath.startsWith(homeReal + path.sep)) {
    return true;
  }
  if (projectPath) {
    try {
      const projectReal = fs.realpathSync.native
        ? fs.realpathSync.native(projectPath)
        : fs.realpathSync(projectPath);
      if (resolvedPath === projectReal || resolvedPath.startsWith(projectReal + path.sep)) {
        return true;
      }
    } catch {
      // projectPath invalid or not accessible
    }
  }
  return false;
}

/**
 * Open worktree in Cursor or VS Code.
 * @param {{ worktreePath: string, editorId: 'cursor'|'vscode', projectPath?: string }} payload
 * @returns {{ success: boolean, error?: string }}
 */
ipcMain.handle('review-locally:open-editor', async (_event, payload) => {
  const { worktreePath, editorId, projectPath } = payload ?? {};
  if (typeof worktreePath !== 'string' || !worktreePath.trim()) {
    return { success: false, error: 'worktreePath is required and must be a non-empty string' };
  }
  if (editorId !== 'cursor' && editorId !== 'vscode') {
    return { success: false, error: "editorId must be 'cursor' or 'vscode'" };
  }

  let resolvedPath;
  try {
    resolvedPath = path.resolve(worktreePath.trim());
  } catch {
    return { success: false, error: 'Invalid worktree path' };
  }

  if (!fs.existsSync(resolvedPath)) {
    return { success: false, error: `Worktree not found at ${resolvedPath}` };
  }

  let realPath;
  try {
    realPath = fs.realpathSync(resolvedPath);
  } catch (err) {
    return { success: false, error: err?.message || 'Failed to resolve path' };
  }

  if (!isPathUnderSafeBase(realPath, projectPath)) {
    return { success: false, error: 'Worktree path must be under project or user home' };
  }

  const isDarwin = process.platform === 'darwin';
  const spawnOpts = { detached: true, stdio: 'ignore' };

  try {
    if (isDarwin) {
      const appName = editorId === 'cursor' ? 'Cursor' : 'Visual Studio Code';
      const child = spawn('open', ['-a', appName, realPath], spawnOpts);
      child.unref();
    } else {
      const cmd = editorId === 'cursor' ? 'cursor' : 'code';
      const child = spawn(cmd, [realPath], spawnOpts);
      child.unref();
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err?.message || 'Failed to spawn editor' };
  }
});

function setDockIcon() {
  if (process.platform !== 'darwin') return;
  const iconPath = getIconPath();
  const icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) {
    app.dock.setIcon(icon);
  }
}

app.whenReady().then(() => {
  app.setName('Code-Auto');
  setDockIcon();
  nativeTheme.on('updated', setDockIcon);
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
