/**
 * Cross-platform build preparation.
 * Removes dist-electron, runs next build, copies public and static into standalone.
 * Use: node scripts/prepare-build.js && electron-builder
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const cwd = process.cwd();
const distDir = path.join(cwd, 'dist-electron');
const standaloneDir = path.join(cwd, '.next', 'standalone');
const publicDir = path.join(cwd, 'public');
const staticDir = path.join(cwd, '.next', 'static');
const standaloneStaticDir = path.join(standaloneDir, '.next', 'static');

// 1. Remove dist-electron
if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true });
}

// 2. Run next build
execSync('yarn next:build', { stdio: 'inherit', cwd });

// 3. Copy public into standalone
if (!fs.existsSync(standaloneDir)) {
  console.error(
    'Error: .next/standalone not found. Ensure next.config.js has output: "standalone".'
  );
  process.exit(1);
}
fs.cpSync(publicDir, path.join(standaloneDir, 'public'), { recursive: true });

// 4. Copy .next/static into standalone/.next/
fs.mkdirSync(path.dirname(standaloneStaticDir), { recursive: true });
fs.cpSync(staticDir, standaloneStaticDir, { recursive: true });
