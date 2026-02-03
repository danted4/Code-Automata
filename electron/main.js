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
const { execSync, spawn } = require('child_process');

const isDev = !app.isPackaged;
const DEFAULT_PORT = parseInt(process.env.PORT || '3000', 10);
const PORT_RANGE = 10; // try 3000..3009 if default is busy

let mainWindow = null;
let nextServer = null;
let nextServerProcess = null;
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
 * Common CLI paths (agent, amp, gh, cursor, code).
 * Always add these for packaged apps since shell PATH may be empty/unreliable.
 */
function getCommonCliPaths() {
  const home = os.homedir();
  const platform = process.platform;

  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    return [
      path.join(appData, 'npm'),
      path.join(localAppData, 'Programs'),
      path.join(programFiles, 'nodejs'),
      path.join(programFilesX86, 'nodejs'),
      path.join(home, '.volta', 'bin'),
      path.join(home, '.fnm'),
    ].filter((p) => fs.existsSync(p));
  }

  return [
    path.join(home, '.local', 'bin'),
    path.join(home, '.cursor', 'bin'),
    path.join(home, 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
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
  const commonPaths = getCommonCliPaths();

  if (process.platform === 'win32') {
    const pathSep = ';';
    const merged = [commonPaths.join(pathSep), process.env.PATH].filter(Boolean).join(pathSep);
    if (merged) process.env.PATH = merged;
    return;
  }

  const shellEnv = { ...process.env, HOME: home, USER: process.env.USER || os.userInfo().username };
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
  const dockIcon = useDark ? 'code-automata-dock.png' : 'code-automata-dock-light.png';
  const fallbackIcon = 'code-automata-dark.png';
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
 * Resolve node binary - when launched from GUI, PATH is minimal.
 */
function resolveNodeBinary() {
  const home = os.homedir();
  const platform = process.platform;
  let candidates = [];

  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    candidates = [
      path.join(programFiles, 'nodejs', 'node.exe'),
      path.join(localAppData, 'Programs', 'node', 'node.exe'),
      path.join(home, '.volta', 'bin', 'node.exe'),
      path.join(home, '.fnm', 'node-versions', 'current', 'installation', 'node.exe'),
    ];
    try {
      const nvmDir = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'nvm');
      if (fs.existsSync(nvmDir)) {
        const nvmExe = path.join(nvmDir, 'node.exe');
        if (fs.existsSync(nvmExe)) candidates.push(nvmExe);
      }
    } catch {}
  } else if (platform === 'linux') {
    candidates = [
      '/usr/bin/node',
      '/usr/local/bin/node',
      path.join(home, '.volta', 'bin', 'node'),
      path.join(home, '.fnm', 'node-versions', 'current', 'installation', 'bin', 'node'),
      path.join(home, '.local', 'share', 'nvm', 'current', 'bin', 'node'),
    ];
    try {
      const nvmDir = path.join(home, '.nvm', 'versions', 'node');
      if (fs.existsSync(nvmDir)) {
        const versions = fs.readdirSync(nvmDir).filter((v) => v.startsWith('v'));
        versions.sort((a, b) => b.localeCompare(a));
        for (const v of versions) {
          candidates.push(path.join(nvmDir, v, 'bin', 'node'));
        }
      }
    } catch {}
  } else {
    candidates = [
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
      path.join(home, '.volta', 'bin', 'node'),
      path.join(home, '.fnm', 'node-versions', 'current', 'installation', 'bin', 'node'),
    ];
    try {
      const nvmDir = path.join(home, '.nvm', 'versions', 'node');
      if (fs.existsSync(nvmDir)) {
        const versions = fs.readdirSync(nvmDir).filter((v) => v.startsWith('v'));
        versions.sort((a, b) => b.localeCompare(a));
        for (const v of versions) {
          candidates.push(path.join(nvmDir, v, 'bin', 'node'));
        }
      }
    } catch {}
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const cmd = platform === 'win32' ? 'where node' : 'which node';
    const out = execSync(cmd, { encoding: 'utf8', env: process.env }).trim().split('\n')[0]?.trim();
    if (out && fs.existsSync(out)) return out;
  } catch {}
  return platform === 'win32' ? 'node.exe' : 'node';
}

/**
 * Start Next.js standalone server as subprocess.
 * Uses first available port in range [DEFAULT_PORT, DEFAULT_PORT + PORT_RANGE).
 */
async function startNextServerInBackground() {
  const appPath = app.getAppPath();
  const resourcesDir = appPath.endsWith('app.asar') ? path.dirname(appPath) : appPath;
  const standaloneDir = path.join(resourcesDir, 'app.asar.unpacked', '.next', 'standalone');
  const serverPath = path.join(standaloneDir, 'server.js');

  if (!fs.existsSync(serverPath)) {
    showLoadingError('Standalone server not found. Rebuild the app.');
    return;
  }

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

  const nodeBin = resolveNodeBinary();
  try {
    nextServerProcess = spawn(nodeBin, ['server.js'], {
      cwd: standaloneDir,
      env: {
        ...process.env,
        PORT: String(port),
        HOSTNAME: '127.0.0.1',
        CODE_AUTOMATA_PACKAGED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    nextServerProcess.on('error', (err) => {
      console.error('Next.js server spawn error:', err);
      showLoadingError('Failed to start server.');
    });
    nextServerProcess.stdout?.on('data', (d) => process.stdout.write(d));
    nextServerProcess.stderr?.on('data', (d) => process.stderr.write(d));

    const ready = await waitForServer(url, 30000);
    if (ready && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(url);
    } else if (!ready) {
      showLoadingError('Server failed to start in time.');
    }
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
<title>Code-Automata</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2rem}.container{text-align:center;max-width:320px}.logo{font-size:1.75rem;font-weight:700;color:#fbbf24;margin-bottom:1.5rem;letter-spacing:-.02em}.spinner{width:40px;height:40px;margin:0 auto 1.5rem;border:3px solid #334155;border-top-color:#fbbf24;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.message{color:#94a3b8;font-size:.9375rem;line-height:1.5}.error{display:none;color:#ef4444;font-size:.875rem;margin-top:1rem;padding:.75rem 1rem;background:rgba(239,68,68,.1);border-radius:.5rem}.error.visible{display:block}</style>
</head>
<body><div class="container"><div class="logo">Code-Automata</div><div class="spinner" id="spinner"></div><p class="message" id="message">Starting application…</p><p class="error" id="error"></p></div></body></html>`;

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

const CURSOR_APP_PATH_DARWIN = '/Applications/Cursor.app';
const VSCODE_APP_PATH_DARWIN = '/Applications/Visual Studio Code.app';

/**
 * Check if a CLI command is available (e.g. `cursor`, `code`).
 * @param {string} cmd - Command name
 * @returns {boolean}
 */
function isCliAvailable(cmd) {
  try {
    const checkCmd = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
    execSync(checkCmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function getCursorAppPaths() {
  const platform = process.platform;
  const home = os.homedir();
  if (platform === 'darwin') return [CURSOR_APP_PATH_DARWIN];
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [path.join(localAppData, 'Programs', 'Cursor', 'Cursor.exe')];
  }
  return [
    path.join(home, '.local', 'share', 'cursor', 'Cursor'),
    '/opt/Cursor/cursor',
    '/opt/cursor/cursor',
  ];
}

function getVscodeAppPaths() {
  const platform = process.platform;
  const home = os.homedir();
  if (platform === 'darwin') return [VSCODE_APP_PATH_DARWIN];
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [path.join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe')];
  }
  return ['/usr/share/code/code', '/usr/bin/code'];
}

/**
 * Detect available editors (Cursor, VS Code).
 * @returns {{ id: 'cursor'|'vscode', label: string, available: boolean }[]}
 */
function getDetectedEditors() {
  const cursorCli = isCliAvailable('cursor');
  const cursorApp = getCursorAppPaths().some((p) => fs.existsSync(p));
  const cursorAvailable = cursorCli || cursorApp;

  const vscodeCli = isCliAvailable('code');
  const vscodeApp = getVscodeAppPaths().some((p) => fs.existsSync(p));
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
 *   projectPath - Project root; when provided, worktree may be under this (allows projects outside home)
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
  app.setName('Code-Automata');
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
  if (nextServerProcess) {
    nextServerProcess.kill();
    nextServerProcess = null;
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
