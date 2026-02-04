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

// 3. Validate and normalize .next/standalone
if (!fs.existsSync(standaloneDir)) {
  console.error(
    'Error: .next/standalone not found. Ensure next.config.js has output: "standalone".'
  );
  process.exit(1);
}

// Next.js standalone can occasionally end up nested like:
// .next/standalone/.next/standalone/server.js
// Flatten that structure so Electron sees server.js at .next/standalone/server.js.
const serverJsPath = path.join(standaloneDir, 'server.js');
if (!fs.existsSync(serverJsPath)) {
  const nestedStandalone = path.join(standaloneDir, '.next', 'standalone');
  const nestedServerJs = path.join(nestedStandalone, 'server.js');
  if (fs.existsSync(nestedServerJs)) {
    console.log('Flattening nested .next/standalone structure...');
    const entries = fs.readdirSync(nestedStandalone);
    for (const entry of entries) {
      const src = path.join(nestedStandalone, entry);
      const dest = path.join(standaloneDir, entry);
      fs.cpSync(src, dest, { recursive: true });
    }
    // Remove the extra nested .next directory to avoid confusion
    const nestedNextDir = path.join(standaloneDir, '.next');
    if (fs.existsSync(nestedNextDir)) {
      fs.rmSync(nestedNextDir, { recursive: true, force: true });
    }
  }
}

// 4. Copy public into standalone
fs.cpSync(publicDir, path.join(standaloneDir, 'public'), { recursive: true });

// 5. Copy .next/static into standalone/.next/
fs.mkdirSync(path.dirname(standaloneStaticDir), { recursive: true });
fs.cpSync(staticDir, standaloneStaticDir, { recursive: true });
