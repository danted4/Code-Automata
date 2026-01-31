#!/usr/bin/env node
/**
 * Dev script: finds an available port, starts Next.js on it, waits for readiness,
 * then starts Electron. Ensures Code-Auto always loads its own app, not another
 * service that might be on port 3000.
 */

const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const path = require('path');

const DEFAULT_PORT = 3000;
const PORT_RANGE = 10;

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

async function findAvailablePort(start, count) {
  for (let i = 0; i < count; i++) {
    const port = start + i;
    if (await isPortAvailable(port)) return port;
  }
  return null;
}

function waitForServer(url, timeoutMs = 60000) {
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
        setTimeout(tryConnect, 300);
      });
      req.setTimeout(3000, () => {
        req.destroy();
        if (Date.now() - start > timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(tryConnect, 300);
      });
    }
    tryConnect();
  });
}

async function main() {
  const port = await findAvailablePort(DEFAULT_PORT, PORT_RANGE);
  if (port === null) {
    console.error(
      `Ports ${DEFAULT_PORT}-${DEFAULT_PORT + PORT_RANGE - 1} are in use. Please free one and try again.`
    );
    process.exit(1);
  }

  console.log(`[Code-Auto] Using port ${port} (ensures our app loads, not another service)`);

  const cwd = path.resolve(__dirname, '..');
  const env = { ...process.env, PORT: String(port) };

  // Spawn Next.js (use .bin/next for cross-platform: next on Unix, next.cmd on Windows)
  const nextBin = path.join(cwd, 'node_modules', '.bin', 'next');
  const next = spawn(nextBin, ['dev'], {
    env,
    stdio: 'inherit',
    cwd,
    shell: process.platform === 'win32',
  });

  // Wait for Next.js to be ready
  const apiUrl = `http://127.0.0.1:${port}/api/tasks/list`;
  const ready = await waitForServer(apiUrl);
  if (!ready) {
    next.kill('SIGTERM');
    console.error('[Code-Auto] Timeout waiting for Next.js. Exiting.');
    process.exit(1);
  }

  // Spawn Electron with same PORT so main.js loads our app
  const electronBin = path.join(cwd, 'node_modules', '.bin', 'electron');
  const electron = spawn(electronBin, ['.'], {
    env,
    stdio: 'inherit',
    cwd,
    shell: process.platform === 'win32',
  });

  electron.on('exit', (code) => {
    next.kill('SIGTERM');
    process.exit(code ?? 0);
  });

  next.on('exit', (code) => {
    electron.kill('SIGTERM');
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error('[Code-Auto] Dev script error:', err);
  process.exit(1);
});
