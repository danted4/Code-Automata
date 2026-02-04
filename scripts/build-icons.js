/**
 * Build platform-specific icons for electron-builder.
 * - Windows: build/icon.ico (from public/code-automata-dock.png)
 * - Linux: build/icons/*.png (16, 32, 48, 64, 128, 256, 512)
 * Uses the curved (squircle) icon so all platforms match the macOS dock style.
 */
const path = require('path');
const fs = require('fs');

const cwd = path.resolve(__dirname, '..');
const inputPng = path.join(cwd, 'public', 'code-automata-dock.png');
const buildDir = path.join(cwd, 'build');
const iconsDir = path.join(buildDir, 'icons');

async function buildIcons() {
  if (!fs.existsSync(inputPng)) {
    console.warn(
      'Skipping icon build: public/code-automata-dock.png not found (run icon:build first)'
    );
    return;
  }

  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(iconsDir, { recursive: true });

  // Windows: PNG to ICO
  try {
    const pngToIco = (await import('png-to-ico')).default;
    const buf = await pngToIco(inputPng);
    fs.writeFileSync(path.join(buildDir, 'icon.ico'), buf);
    console.log('Created build/icon.ico');
  } catch (err) {
    console.warn('Could not create icon.ico:', err.message);
  }

  // Linux: multiple sizes
  try {
    const sharp = require('sharp');
    const sizes = [16, 32, 48, 64, 128, 256, 512];
    for (const size of sizes) {
      await sharp(inputPng)
        .resize(size, size)
        .png()
        .toFile(path.join(iconsDir, `${size}x${size}.png`));
    }
    console.log('Created build/icons/*.png');
  } catch (err) {
    console.warn('Could not create Linux icons:', err.message);
  }
}

buildIcons().catch((err) => {
  console.error(err);
  process.exit(1);
});
