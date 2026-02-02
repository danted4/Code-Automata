/**
 * Electron-builder afterPack hook.
 * Copies .next/standalone/node_modules into the packaged app because
 * electron-builder excludes nested node_modules by default.
 * Removes broken .bin symlinks (e.g. amp-sdk's amp -> @sourcegraph/amp which
 * isn't included in standalone) that cause xattr/codesign to fail.
 */
const path = require('path');
const fs = require('fs');

function removeBrokenSymlinks(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const target = path.resolve(path.dirname(fullPath), fs.readlinkSync(fullPath));
      if (!fs.existsSync(target)) {
        fs.unlinkSync(fullPath);
      }
    } else if (entry.isDirectory()) {
      removeBrokenSymlinks(fullPath);
    }
  }
}

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
  removeBrokenSymlinks(dest);
};
