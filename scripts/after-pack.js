/**
 * Electron-builder afterPack hook.
 * Copies .next/standalone/node_modules into the packaged app because
 * electron-builder excludes nested node_modules by default.
 */
const path = require('path');
const fs = require('fs');

module.exports = async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  if (electronPlatformName !== 'darwin') return;

  const src = path.join(process.cwd(), '.next', 'standalone', 'node_modules');
  const base = packager?.appInfo?.productFilename || 'Code-Auto';
  const appName = base.endsWith('.app') ? base : base + '.app';
  const dest = path.join(
    appOutDir,
    appName,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    '.next',
    'standalone',
    'node_modules'
  );

  if (!fs.existsSync(src) || !fs.existsSync(path.dirname(dest))) return;

  fs.cpSync(src, dest, { recursive: true });
};
