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
const http = require('http');
const net = require('net');
const { execSync } = require('child_process');

const isDev = !app.isPackaged;
const DEFAULT_PORT = parseInt(process.env.PORT || '3000', 10);
const PORT_RANGE = 10; // try 3000..3009 if default is busy

let mainWindow = null;
let nextServer = null;
let serverPort = DEFAULT_PORT;
let appUrl = null; // Reuse same URL when reopening window (keeps localStorage)

/**
 * Check if a port is available.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Find first available port in range [start, start + count).
 * @param {number} start
 * @param {number} count
 * @returns {Promise<number|null>}
 */
async function findAvailablePort(start, count) {
  for (let i = 0; i < count; i++) {
    const port = start + i;
    if (await isPortAvailable(port)) return port;
  }
  return null;
}

/**
 * Common CLI paths on macOS (agent, amp, gh, cursor, code).
 * Always add these for packaged apps since shell PATH may be empty/unreliable.
 */
function getCommonCliPaths() {
  const home = os.homedir();
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, '.cursor', 'bin'),
    path.join(home, 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.yarn', 'bin'),
  ].filter((p) => fs.existsSync(p));
}

/**
 * When packaged, GUI apps get minimal PATH and no shell env (CURSOR_API_KEY etc).
 * Enhance process.env with user's login shell PATH so `which agent` and CLI tools work.
 */
function enhanceEnvForPackagedApp() {
  if (isDev) return;
  const home = os.homedir();
  const shellEnv = { ...process.env, HOME: home, USER: process.env.USER || os.userInfo().username };
  const commonPaths = getCommonCliPaths();
  const commonPathStr = commonPaths.join(':');

  let shellPath = '';
  const shells = [...new Set([process.env.SHELL, '/bin/zsh', '/bin/bash'].filter(Boolean))];
  for (const sh of shells) {
    try {
      shellPath = execSync(`${sh} -l -c 'echo $PATH'`, {
        encoding: 'utf8',
        timeout: 3000,
        env: shellEnv,
      }).trim();
      if (shellPath) break;
    } catch {
      continue;
    }
  }

  const merged = [shellPath, commonPathStr, process.env.PATH].filter(Boolean).join(':');
  if (merged) process.env.PATH = merged;

  const envVars = ['CURSOR_API_KEY', 'AMP_API_KEY'];
  for (const name of envVars) {
    if (!process.env[name]) {
      for (const sh of ['/bin/zsh', '/bin/bash'].filter(Boolean)) {
        try {
          const val = execSync(`${sh} -l -c 'echo $${name}'`, {
            encoding: 'utf8',
            timeout: 2000,
            env: shellEnv,
          }).trim();
          if (val && !val.startsWith('$')) {
            process.env[name] = val;
            break;
          }
        } catch {
          continue;
        }
      }
    }
  }
}
let nextServer = null;
let serverPort = DEFAULT_PORT;
let appUrl = null; // Reuse same URL when reopening window (keeps localStorage)

/**
 * Check if a port is available.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Find first available port in range [start, start + count).
 * @param {number} start
 * @param {number} count
 * @returns {Promise<number|null>}
 */
async function findAvailablePort(start, count) {
  for (let i = 0; i < count; i++) {
    const port = start + i;
    if (await isPortAvailable(port)) return port;
  }
  return null;
}

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

/**
 * Wait for Next.js server to be ready.
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve) => {
    function tryConnect() {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(tryConnect, 200);
      });
      req.setTimeout(1000, () => {
        req.destroy();
        if (Date.now() - start > timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(tryConnect, 200);
      });
    }
    tryConnect();
  });
}

/**
 * Start Next.js server in-process (no subprocess, no extra Dock icon).
 * Uses first available port in range [DEFAULT_PORT, DEFAULT_PORT + PORT_RANGE) if 3000 is busy.
 */
async function startNextServerInBackground() {
  const appPath = app.getAppPath();
  const port = await findAvailablePort(DEFAULT_PORT, PORT_RANGE);
  if (port === null) {
    showLoadingError(
      `Ports ${DEFAULT_PORT}-${DEFAULT_PORT + PORT_RANGE - 1} are in use. Please free one and try again.`
    );
    return;
  }
  serverPort = port;
  const url = `http://localhost:${port}`;
  appUrl = url;
  process.env.NEXT_PUBLIC_APP_URL = url;
  try {
    const next = require('next');
    const nextApp = next({ dev: false, dir: appPath });
    const handle = nextApp.getRequestHandler();
    await nextApp.prepare();
    nextServer = http.createServer((req, res) => handle(req, res));
    nextServer.listen(port, '127.0.0.1', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(url);
      }
    });
    nextServer.on('error', (err) => {
      console.error('Next.js server error:', err);
      showLoadingError('Failed to start server.');
    });
  } catch (err) {
    console.error('Next.js init error:', err);
    showLoadingError(err?.message || 'Failed to start server.');
  }
}

/**
 * Show error state on the loading page.
 * @param {string} message
 */
function showLoadingError(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents
    .executeJavaScript(
      `
    (function() {
      var el = document.getElementById('error');
      var spinner = document.getElementById('spinner');
      var msg = document.getElementById('message');
      if (el) { el.textContent = ${JSON.stringify(message)}; el.classList.add('visible'); }
      if (spinner) spinner.style.display = 'none';
      if (msg) msg.textContent = 'Something went wrong';
    })();
  `
    )
    .catch(() => {});
}

const LOADING_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Code-Auto</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2rem}.container{text-align:center;max-width:320px}.logo{font-size:1.75rem;font-weight:700;color:#fbbf24;margin-bottom:1.5rem;letter-spacing:-.02em}.spinner{width:40px;height:40px;margin:0 auto 1.5rem;border:3px solid #334155;border-top-color:#fbbf24;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.message{color:#94a3b8;font-size:.9375rem;line-height:1.5}.error{display:none;color:#ef4444;font-size:.875rem;margin-top:1rem;padding:.75rem 1rem;background:rgba(239,68,68,.1);border-radius:.5rem}.error.visible{display:block}</style>
</head>
<body><div class="container"><div class="logo">Code-Auto</div><div class="spinner" id="spinner"></div><p class="message" id="message">Starting application…</p><p class="error" id="error"></p></div></body></html>`;

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

  if (isDev) {
    const devPort = process.env.PORT || DEFAULT_PORT;
    mainWindow.loadURL(`http://localhost:${devPort}`);
  } else if (appUrl) {
    mainWindow.loadURL(appUrl);
  } else {
    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(LOADING_HTML));
    startNextServerInBackground();
  }

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
  enhanceEnvForPackagedApp();
  setDockIcon();
  nativeTheme.on('updated', setDockIcon);
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (nextServer) {
    nextServer.close();
    nextServer = null;
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
